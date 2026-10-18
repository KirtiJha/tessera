/**
 * Session lifecycle from the console: stop a session's turn, hand it to a
 * colleague, and read its timeline for replay.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { issueDevice } from "../auth/devices.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe.skipIf(!reachable)("session lifecycle", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  const sid = `life-${sfx}`;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let token = "";

  const report = (status: "running" | "waiting", extra: Record<string, unknown> = {}, events: unknown[] = []) =>
    app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sid, status, startedAt: new Date(Date.now() - 600_000).toISOString(), ...extra }, events },
    });
  const decide = () => app.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { sessionId: sid, tool: "Bash", command: "make deploy" } });
  const as = (who: string, method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: method === "GET" ? { cookie: cookies[who]! } : { ...H, cookie: cookies[who]! }, payload });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Life Co', $2)", [orgId, `life-${sfx}`]);
    const pw = await hashPassword("password-12345");
    for (const [who, role] of [["owner", "operator"], ["mate", "operator"], ["watcher", "viewer"]] as const) {
      const r = await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id", [orgId, `${who}-${sfx}@life.test`, who[0]!.toUpperCase() + who.slice(1), role, pw]);
      ids[who] = r.rows[0]!.id;
      cookies[who] = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `${who}-${sfx}@life.test`, password: "password-12345" } }));
    }
    token = (await issueDevice(orgId, ids.owner!, "laptop")).token;
    await report("running", { cwd: "/srv/app" }, [{ id: "e1", ts: new Date(Date.now() - 500_000).toISOString(), kind: "turn.start", text: "prompt: deploy the fix" }]);
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("stops the turn at the next tool call, once", async () => {
    expect((await as("mate", "POST", `/api/fleet/sessions/${sid}/stop`, {})).statusCode).toBe(403);
    expect((await as("owner", "POST", `/api/fleet/sessions/${sid}/stop`, { reason: "Wrong branch" })).json()).toEqual({ ok: true });
    const view = (await as("owner", "GET", `/api/fleet/sessions/${sid}`)).json();
    expect(view.session.stopRequested).toBe(true);
    expect((await decide()).json()).toEqual({ decision: "deny", stop: true, reason: "Stopped from Tessera by Owner: Wrong branch Wait for the engineer before continuing." });
    expect((await decide()).json()).toEqual({ decision: "allow", reason: null });
    const a = await pool.query("SELECT action, detail FROM audit_log WHERE org_id = $1 AND action = 'session.stop'", [orgId]);
    expect(a.rows[0]!.detail).toEqual({ reason: "Wrong branch" });
  });

  it("drops a stop that never met a tool call once the turn is over", async () => {
    await as("owner", "POST", `/api/fleet/sessions/${sid}/stop`, {});
    await report("waiting", { waitReason: "idle" });
    expect((await as("owner", "GET", `/api/fleet/sessions/${sid}`)).json().session.stopRequested).toBe(false);
    await report("running");
    expect((await decide()).json().decision).toBe("allow");
  });

  it("hands a session to a colleague, who can then act on it", async () => {
    const people = (await as("owner", "GET", "/api/fleet/people")).json().people.map((p: { name: string }) => p.name);
    expect(people).toEqual(["Mate", "Owner"]);
    expect((await as("owner", "POST", `/api/fleet/sessions/${sid}/assign`, { userId: ids.watcher })).json().error).toContain("viewer");
    expect((await as("owner", "POST", `/api/fleet/sessions/${sid}/assign`, { userId: ids.mate })).json()).toEqual({ ok: true });
    const view = (await as("mate", "GET", `/api/fleet/sessions/${sid}`)).json();
    expect(view.session.assignee).toEqual({ id: ids.mate, name: "Mate" });
    expect(view.canAct).toBe(true);
    expect((await as("mate", "POST", `/api/fleet/sessions/${sid}/pause`, { paused: true })).statusCode).toBe(200);
    expect((await as("mate", "POST", `/api/fleet/sessions/${sid}/pause`, { paused: false })).statusCode).toBe(200);
    // Handed back: the colleague loses the right again.
    await as("owner", "POST", `/api/fleet/sessions/${sid}/assign`, { userId: null });
    expect((await as("mate", "GET", `/api/fleet/sessions/${sid}`)).json().canAct).toBe(false);
    const a = await pool.query("SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'session.%assign' ORDER BY id", [orgId]);
    expect(a.rows.map((r) => r.action)).toEqual(["session.assign", "session.unassign"]);
  });

  it("returns a timeline with events, prompts and cost in time order", async () => {
    await report("waiting", { waitReason: "permission", openAsk: { id: "ask-t", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(make deploy)" } }, [{ id: "e2", ts: new Date().toISOString(), kind: "wait", text: "waiting on you: Bash(make deploy)" }]);
    await pool.query("INSERT INTO samples (org_id, session_id, ts, tokens_total, tokens_delta, cost_usd) VALUES ($1,$2,now() - interval '5 minutes', 1000, 1000, 0.25)", [orgId, sid]);
    const t = (await as("watcher", "GET", `/api/fleet/sessions/${sid}/timeline`)).json();
    expect(t.events.map((e: { id: string }) => e.id)).toEqual(["e1", "e2"]);
    expect(t.asks).toEqual([expect.objectContaining({ id: "ask-t", kind: "permission", tool: "Bash", closedAt: null })]);
    expect(t.samples).toEqual([expect.objectContaining({ tokens: 1000, delta: 1000, costUsd: 0.25 })]);
    expect(t.startedAt).toBeTruthy();
  });
});
