/**
 * Two replicas behind a load balancer: a report to one and an action on the
 * other must meet. Needs PostgreSQL and Redis (REDIS_URL, default
 * redis://127.0.0.1:6379); skipped when either is missing.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.REDIS_URL ??= process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const { pool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");
const { hashPassword } = await import("../auth/crypto.js");
const { issueDevice } = await import("../auth/devices.js");

async function up(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
  } catch {
    return false;
  }
  const u = new URL(process.env.REDIS_URL!);
  return new Promise((res) => {
    const s = net.connect(Number(u.port || 6379), u.hostname, () => (s.end(), res(true)));
    s.on("error", () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 1000);
  });
}
const reachable = await up();
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const until = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!reachable)("several replicas", () => {
  type Built = Awaited<ReturnType<typeof import("../app.js").buildApp>>;
  let a: Built;
  let b: Built;
  const orgId = randomUUID();
  const sid = `ha-${orgId.slice(0, 6)}`;
  let token = "";
  let cookie = "";

  const report = (app: Built, openAsk: Record<string, unknown> | null) =>
    app.server.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sid, status: openAsk ? "waiting" : "running", waitReason: openAsk ? "permission" : null, startedAt: new Date().toISOString(), openAsk: openAsk ? { createdAt: new Date().toISOString(), options: [], ...openAsk } : null }, events: [] },
    });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    a = await buildApp();
    b = await buildApp();
    for (const x of [a, b]) {
      await x.server.ready();
      await x.hub.start();
    }
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'HA Co', $2)", [orgId, `ha-${orgId.slice(0, 8)}`]);
    const u = await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Hal','owner',$3) RETURNING id", [orgId, `hal-${orgId.slice(0, 6)}@ha.test`, await hashPassword("password-12345")]);
    token = (await issueDevice(orgId, u.rows[0]!.id, "laptop")).token;
    const r = await b.server.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `hal-${orgId.slice(0, 6)}@ha.test`, password: "password-12345" } });
    cookie = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;
  });

  afterAll(async () => {
    for (const x of [a, b]) {
      await x.hub.stop();
      await x.server.close();
    }
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("answers on one replica a prompt reported to the other", async () => {
    expect((await report(a, { id: "ask-ha", kind: "permission", tool: "Bash", prompt: "Bash(make deploy)" })).statusCode).toBe(200);
    await until(() => b.fleet.get(orgId, sid)?.openAsk?.id === "ask-ha");
    const state = (await b.server.inject({ method: "GET", url: "/api/fleet/state", headers: { cookie } })).json();
    expect(state.sessions.map((s: { id: string }) => s.id)).toContain(sid);
    const r = await b.server.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie }, payload: { askId: "ask-ha", decision: "allow" } });
    expect(r.statusCode).toBe(200);
  });

  it("applies a pause made on one replica to tool calls checked by the other", async () => {
    await report(a, null);
    await until(() => b.fleet.get(orgId, sid)?.status === "running");
    expect((await b.server.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/pause`, headers: { ...H, cookie }, payload: { paused: true, reason: "freeze" } })).statusCode).toBe(200);
    await until(() => a.fleet.get(orgId, sid)?.control.paused === true);
    const d = await a.server.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { sessionId: sid, tool: "Bash" } });
    expect(d.json()).toEqual({ decision: "deny", reason: "Session paused in Tessera: freeze" });
    // A later report to the first replica keeps the pause.
    await report(a, null);
    expect(a.fleet.get(orgId, sid)?.control.paused).toBe(true);
  });

  it("removes a session from every replica", async () => {
    expect((await b.server.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/drop`, headers: { "x-tessera-client": "web", cookie } })).statusCode).toBe(200);
    await until(() => a.fleet.get(orgId, sid) === undefined);
  });
});
