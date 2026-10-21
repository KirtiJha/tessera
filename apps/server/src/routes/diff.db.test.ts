/**
 * Diffs asked for from the console: queued to the machine as a command, sent
 * back redacted, held in memory, and refused to people who cannot act on the
 * session or to organisations that keep metadata only. And the context fill
 * that the timeline draws.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { pool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");
const { hashPassword } = await import("../auth/crypto.js");
const { issueDevice } = await import("../auth/devices.js");
const { invalidateDataSettings } = await import("../fleet/datasettings.js");

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe.skipIf(!reachable)("diffs on demand and the context timeline", () => {
  let app: FastifyInstance;
  let flush: () => Promise<void>;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let admin = "";
  let member = "";
  let token = "";
  const sid = `diff-${sfx}`;
  const dev = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const report = (session: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/ingest/report", headers: dev(), payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "ann-mbp", machineId: "m" }, session: { id: sid, startedAt: new Date(Date.now() - 600_000).toISOString(), cwd: "/r", status: "running", ...session }, events: [], ...extra } });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    const built = await buildApp();
    app = built.server;
    // The test app does not start the fleet's timers: flush the per-minute samples by hand.
    flush = () => (built.fleet as unknown as { flushSamples: () => Promise<void> }).flushSamples();
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Diff',$2)", [orgId, `diff-${sfx}`]);
    const pw = await hashPassword("password-12345");
    const uid = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Ann','admin',$3) RETURNING id", [orgId, `ann-${sfx}@diff.test`, pw])).rows[0]!.id;
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Bo','viewer',$3)", [orgId, `bo-${sfx}@diff.test`, pw]);
    admin = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@diff.test`, password: "password-12345" } }));
    member = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `bo-${sfx}@diff.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, uid, "ann-mbp")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("asks the machine, which takes the command with its keep-alive, and shows what it sent with DLP applied", async () => {
    await report({});
    const ask = await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin }, payload: {} });
    expect(ask.statusCode).toBe(200);
    const { requestId } = ask.json() as { requestId: string };
    // A second click while the first is out reuses it.
    expect((await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin }, payload: {} })).json().requestId).toBe(requestId);
    expect((await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin } })).json().status).toBe("pending");
    // The keep-alive claims commands only; a message queued meanwhile stays for the hooks.
    await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/message`, headers: { ...H, cookie: admin }, payload: { text: "hi" } });
    const ka = (await report({}, { claimKinds: ["command"] })).json() as { deliveries: { kind: string; payload: { op: string; requestId: string } }[] };
    expect(ka.deliveries.map((d) => d.kind)).toEqual(["command"]);
    expect(ka.deliveries[0]!.payload).toMatchObject({ op: "diff", requestId });
    await pool.query("UPDATE orgs SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{data}', '{\"dlp\":{\"emails\":true}}') WHERE id = $1", [orgId]);
    invalidateDataSettings(orgId);
    const up = await app.inject({ method: "POST", url: `/api/ingest/sessions/${sid}/diff`, headers: dev(), payload: { requestId, files: [{ path: "a.ts", status: "modified", diff: "@@ -1 +1 @@\n-x\n+mail ann@acme.test\n" }] } });
    expect(up.statusCode).toBe(200);
    const view = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin } })).json();
    expect(view).toMatchObject({ status: "ready", requestedBy: "Ann", files: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+mail [email]\n" }] });
    // An answer to a stale request is refused.
    expect((await app.inject({ method: "POST", url: `/api/ingest/sessions/${sid}/diff`, headers: dev(), payload: { requestId: "old", files: [] } })).statusCode).toBe(409);
    const audit = await pool.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'session.diff'", [orgId]);
    expect(audit.rowCount).toBe(1);
  });

  it("asks about another repository the session worked in, and only one it reported", async () => {
    const workedIn = [
      { dir: "/w/workflow", repo: "acme/workflow", branch: "main", current: false, filesChanged: [{ path: "deck.pptx", status: "untracked", added: 0, removed: 0 }] },
      { dir: "/w/porthaven", repo: "acme/porthaven", branch: "main", current: true, filesChanged: [{ path: "src/netmap.py", status: "modified", added: 3, removed: 1 }] },
    ];
    await report({ cwd: "/w/porthaven", workedIn });
    const detail = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { ...H, cookie: admin } })).json();
    expect(detail.session.workedIn.map((w: { dir: string }) => w.dir)).toEqual(["/w/workflow", "/w/porthaven"]);
    expect((await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin }, payload: { dir: "/etc" } })).statusCode).toBe(400);
    const { requestId } = (await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin }, payload: { dir: "/w/workflow" } })).json() as { requestId: string };
    const ka = (await report({ cwd: "/w/porthaven", workedIn }, { claimKinds: ["command"] })).json() as { deliveries: { payload: Record<string, unknown> }[] };
    expect(ka.deliveries[0]!.payload).toMatchObject({ op: "diff", requestId, dir: "/w/workflow" });
    expect((await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin } })).json()).toMatchObject({ status: "pending", dir: "/w/workflow" });
    // Kept with the session, so an ended one still says where its work went.
    const row = await pool.query<{ worked_in: { dir: string }[] }>("SELECT worked_in FROM sessions WHERE org_id = $1 AND id = $2", [orgId, sid]);
    expect(row.rows[0]?.worked_in.map((w) => w.dir) ?? []).toEqual(["/w/workflow", "/w/porthaven"]);
  });

  it("is not for people who cannot act on the session, nor for an organisation that keeps metadata only", async () => {
    expect((await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: member } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: member }, payload: {} })).statusCode).toBe(403);
    await pool.query("UPDATE orgs SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{data}', '{\"excerpts\":false}') WHERE id = $1", [orgId]);
    invalidateDataSettings(orgId);
    const r = await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/diff`, headers: { ...H, cookie: admin }, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/metadata only/);
  });

  it("keeps each minute's fullest context reading for the timeline", async () => {
    await report({ context: { used: 150_000, window: 200_000 } });
    await report({ context: { used: 40_000, window: 200_000 } });
    await flush();
    const rows = (await pool.query<{ context_used: number; context_window: number }>("SELECT context_used, context_window FROM samples WHERE org_id = $1 AND session_id = $2", [orgId, sid])).rows;
    expect(rows.at(-1)).toEqual({ context_used: 150_000, context_window: 200_000 });
    const tl = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}/timeline`, headers: { ...H, cookie: admin } })).json() as { samples: { contextUsed: number; contextWindow: number }[] };
    expect(tl.samples.at(-1)).toMatchObject({ contextUsed: 150_000, contextWindow: 200_000 });
  });

  it("counts the tokens in a new session's first report as usage", async () => {
    const id = `first-${sfx}`;
    await app.inject({ method: "POST", url: "/api/ingest/report", headers: dev(), payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id, startedAt: new Date().toISOString(), status: "running", tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 } }, events: [] } });
    await flush();
    const r = await pool.query<{ d: string }>("SELECT SUM(tokens_delta) AS d FROM samples WHERE org_id = $1 AND session_id = $2", [orgId, id]);
    expect(Number(r.rows[0]!.d)).toBe(1200);
  });
});
