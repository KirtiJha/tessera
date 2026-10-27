/**
 * Every tool call kept for the session's whole history; a command's output and
 * an edit's patch kept only where the organisation turned that on, sent once,
 * never on the wall, and shown only to people who can act on the session.
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

describe.skipIf(!reachable)("a session's tool-call history and change history", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let admin = "";
  let viewer = "";
  let token = "";
  const sid = `acts-${sfx}`;
  const t = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const bash = { id: "c1", ts: t(60), tool: "Bash", summary: "Bash(pnpm test)", status: "failed", endedAt: t(50), durationMs: 10_000, error: "1 failed", detail: { command: "pnpm test --run", description: "Run the tests", output: { tail: "FAIL refunds.test.ts\nmail ops@acme.test", lines: 2, truncated: false } } };
  const edit = { id: "c2", ts: t(40), tool: "Edit", summary: "Edit(/w/src/refunds.ts)", status: "ok", endedAt: t(39), durationMs: 20, error: null, detail: { path: "/w/src/refunds.ts", added: 1, removed: 1, patch: "@@ -4,1 +4,1 @@\n-  return 2;\n+  return 3;" } };
  const report = (activity: unknown[]) =>
    app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "ann-mbp", machineId: "m" }, session: { id: sid, status: "running", startedAt: t(600), cwd: "/w", activity }, events: [] },
    });
  const settings = (data: Record<string, unknown>) => pool.query("UPDATE orgs SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{data}', $2::jsonb) WHERE id = $1", [orgId, JSON.stringify(data)]).then(() => invalidateDataSettings(orgId));
  const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { ...H, cookie } });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Acts',$2)", [orgId, `acts-${sfx}`]);
    const pw = await hashPassword("password-12345");
    const uid = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Ann','admin',$3) RETURNING id", [orgId, `ann-${sfx}@acts.test`, pw])).rows[0]!.id;
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Vi','viewer',$3)", [orgId, `vi-${sfx}@acts.test`, pw]);
    admin = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@acts.test`, password: "password-12345" } }));
    viewer = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `vi-${sfx}@acts.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, uid, "ann-mbp")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("keeps every call, but no output or patch until the organisation asks for them", async () => {
    const ack = (await report([bash, edit])).json();
    expect(ack).toMatchObject({ keep: { toolOutput: false, edits: false }, ackedActions: [] });
    const one = (await get(`/api/fleet/sessions/${sid}/actions/c1`, admin)).json();
    expect(one.action.detail).toEqual({ command: "pnpm test --run", description: "Run the tests" });
    expect((await get(`/api/fleet/sessions/${sid}/changes`, admin)).json()).toMatchObject({ canSee: true, kept: false, changes: [] });
  });

  it("with output and edits kept: stores them once with DLP applied, keeps them off the wall, and shows them to those who can act", async () => {
    await settings({ toolOutput: true, editHistory: true, dlp: { emails: true } });
    const ack = (await report([bash, edit])).json();
    expect(ack.keep).toEqual({ toolOutput: true, edits: true });
    expect(ack.ackedActions.sort()).toEqual(["c1", "c2"]);
    // The reporter then sends the calls without them; what was kept stays.
    await report([{ ...bash, detail: { command: bash.detail.command } }, { ...edit, detail: { path: edit.detail.path, added: 1, removed: 1 } }]);
    const one = (await get(`/api/fleet/sessions/${sid}/actions/c1`, admin)).json();
    expect(one.action.detail.output.tail).toBe("FAIL refunds.test.ts\nmail [email]");
    const live = (await get(`/api/fleet/sessions/${sid}`, admin)).json();
    expect(live.session.activity.find((a: { id: string }) => a.id === "c1").detail.output).toBeUndefined();
    const changes = (await get(`/api/fleet/sessions/${sid}/changes`, admin)).json();
    expect(changes.changes.map((c: { id: string; detail: { patch: string } }) => [c.id, c.detail.patch])).toEqual([["c2", edit.detail.patch]]);
    // A viewer sees the call, not its output or the patches.
    expect((await get(`/api/fleet/sessions/${sid}/actions/c1`, viewer)).json().action.detail.output).toBeUndefined();
    expect((await get(`/api/fleet/sessions/${sid}/changes`, viewer)).json()).toMatchObject({ canSee: false, changes: [] });
  });

  it("pages through the whole history, newest first, beyond the last calls a report carries", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, ts: t(500 - i), tool: "Read", summary: `Read(f${i})`, status: "ok", endedAt: t(499 - i), durationMs: 1, error: null }));
    await report(many.slice(0, 40));
    await report(many.slice(5));
    const first = (await get(`/api/fleet/sessions/${sid}/actions?limit=20`, admin)).json();
    expect(first.total).toBe(47);
    expect(first.actions[0].id).toBe("c2");
    const rest = (await get(`/api/fleet/sessions/${sid}/actions?limit=100&before=${encodeURIComponent(first.actions.at(-1).ts)}`, admin)).json();
    expect(first.actions.length + rest.actions.length).toBe(47);
    expect((await get(`/api/fleet/sessions/${sid}/actions?failed=1`, admin)).json().actions.map((a: { id: string }) => a.id)).toEqual(["c1"]);
  });

  it("gives one agent's calls, or the main session's own, so parallel agents can be read apart", async () => {
    const t0 = { tool: "Read", status: "ok", endedAt: t(5), durationMs: 1, error: null };
    await report([
      { ...t0, id: "g1", ts: t(9), summary: "Read(a)", agentId: "ag-1" },
      { ...t0, id: "g2", ts: t(8), summary: "Read(b)", agentId: "ag-2" },
      { ...t0, id: "g3", ts: t(7), summary: "Read(c)", agentId: "ag-1" },
    ]);
    const ids = async (q: string) => (await get(`/api/fleet/sessions/${sid}/actions?${q}`, admin)).json().actions.map((a: { id: string }) => a.id);
    expect(await ids("agent=ag-1")).toEqual(["g3", "g1"]);
    expect(await ids("agent=ag-2")).toEqual(["g2"]);
    const main = await ids("agent=main&limit=200");
    expect(main.filter((id: string) => id.startsWith("g"))).toEqual([]);
    expect(main.length).toBe(47);
  });

  it("says which agent edited which file", async () => {
    const ok = { status: "ok", endedAt: t(3), durationMs: 1, error: null };
    await report([
      { ...ok, id: "w1", ts: t(4), tool: "Edit", summary: "Edit(/w/a.ts)", agentId: "ag-1", detail: { path: "/w/a.ts", added: 1, removed: 0 } },
      { ...ok, id: "w2", ts: t(3), tool: "Write", summary: "Write(/w/a.ts)", agentId: "ag-1", detail: { path: "/w/a.ts", added: 2, removed: 0 } },
      { ...ok, id: "w3", ts: t(2), tool: "Edit", summary: "Edit(/w/b.ts)", agentId: null, detail: { path: "/w/b.ts", added: 1, removed: 1 } },
      { ...ok, id: "w4", ts: t(1), tool: "Read", summary: "Read(/w/c.ts)", agentId: "ag-2", detail: { path: "/w/c.ts" } },
      { ...ok, id: "w5", ts: t(1), tool: "Edit", summary: "Edit(/w/d.ts)", agentId: "ag-2", status: "failed", error: "no match", detail: { path: "/w/d.ts" } },
    ]);
    const { touched } = (await get(`/api/fleet/sessions/${sid}/touched`, viewer)).json();
    const mine = touched.filter((x: { path: string }) => ["/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/d.ts"].includes(x.path)).map((x: { path: string; agentId: string | null; edits: number }) => [x.path, x.agentId, x.edits]).sort();
    expect(mine).toEqual([["/w/a.ts", "ag-1", 2], ["/w/b.ts", null, 1]]);
  });
});
