/**
 * Away mode, the terminal hand-off, personal push notifications, explicit
 * allow rules, and rules suggested from repeated approvals.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Web Push talks HTTPS to the browser vendor's push service: record what would be sent instead.
const sent = vi.hoisted(() => [] as { endpoint: string; payload: Record<string, unknown> }[]);
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "BPublicKeyForTests0000000000000000000000000000000000000000000000000000000000000000000", privateKey: "privateKeyForTests000000000000000000000000" }),
    sendNotification: async (sub: { endpoint: string }, body: string) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) as Record<string, unknown> });
      return { statusCode: 201 };
    },
  },
}));

const { pool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");
const { hashPassword } = await import("../auth/crypto.js");
const { issueDevice } = await import("../auth/devices.js");

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe.skipIf(!reachable)("away mode, hand-off, push, explicit allows and suggestions", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let cookie = "";
  let token = "";
  let uid = "";
  const base = { v: 1, reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "ann-mbp", machineId: "m" } };
  const report = (sid: string, session: Record<string, unknown>, events: unknown[] = []) =>
    app.inject({ method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...base, sentAt: new Date().toISOString(), session: { id: sid, startedAt: new Date(Date.now() - 600_000).toISOString(), cwd: "/r", ...session }, events } });
  const answer = (sid: string, askId: string, decision = "allow") => app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie }, payload: { askId, decision } });
  const prefs = (body: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/me/preferences", headers: { ...H, cookie }, payload: body });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Pres',$2)", [orgId, `pres-${sfx}`]);
    uid = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Ann','admin',$3) RETURNING id", [orgId, `ann-${sfx}@pres.test`, await hashPassword("password-12345")])).rows[0]!.id;
    cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@pres.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, uid, "ann-mbp")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("tells the reporter the owner's away setting, within seconds of a change", async () => {
    expect((await report(`p-${sfx}-1`, { status: "running" })).json().presence).toBe("auto");
    expect((await prefs({ presence: "away" })).json().presence).toBe("away");
    expect((await report(`p-${sfx}-1`, { status: "running" })).json().presence).toBe("away");
    const audit = await pool.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'user.presence'", [orgId]);
    expect(audit.rowCount).toBe(1);
  });

  it("lets the terminal set away mode with the device token, and whoami reads it back", async () => {
    const dev = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const put = await app.inject({ method: "PUT", url: "/api/ingest/presence", headers: dev, payload: { presence: "desk" } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ presence: "desk" });
    expect((await app.inject({ method: "GET", url: "/api/ingest/whoami", headers: dev })).json()).toMatchObject({ user: "Ann", device: "ann-mbp", presence: "desk" });
    expect((await app.inject({ method: "PUT", url: "/api/ingest/presence", headers: dev, payload: { presence: "asleep" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/ingest/presence", headers: { "content-type": "application/json" }, payload: { presence: "away" } })).statusCode).toBe(401);
    const audit = await pool.query<{ detail: { via: string } }>("SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'user.presence' ORDER BY created_at DESC LIMIT 1", [orgId]);
    expect(audit.rows[0]!.detail.via).toBe("terminal");
    await prefs({ presence: "auto" });
  });

  it("hands the mod only messages, and leaves an answer queued for the hook waiting on it", async () => {
    const sid = `p-${sfx}-mod`;
    const dev = { authorization: `Bearer ${token}` };
    await report(sid, { status: "waiting", waitReason: "permission", openAsk: { id: "am", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(x)" } });
    expect((await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/message`, headers: { ...H, cookie }, payload: { text: "push what you have" } })).statusCode).toBe(200);
    expect((await answer(sid, "am")).statusCode).toBe(200);
    const mod = await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries?wait=0&kinds=message`, headers: dev });
    expect(mod.json().deliveries.map((d: { kind: string }) => d.kind)).toEqual(["message"]);
    const hook = await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries?wait=0`, headers: dev });
    expect(hook.json().deliveries.map((d: { kind: string; askId: string }) => [d.kind, d.askId])).toEqual([["answer", "am"]]);
    expect((await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries?kinds=gossip`, headers: dev })).statusCode).toBe(400);
  });

  it("shows which sessions run the mod", async () => {
    const sid = `p-${sfx}-feat`;
    await app.inject({ method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...base, reporter: { ...base.reporter, features: ["mod"] }, sentAt: new Date().toISOString(), session: { id: sid, startedAt: new Date().toISOString(), status: "waiting", waitReason: "idle" }, events: [] } });
    const view = await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { ...H, cookie } });
    expect(view.json().session?.reporter ?? view.json().reporter).toMatchObject({ features: ["mod"] });
  });

  it("refuses an answer once the prompt has moved to the terminal, and says where it is", async () => {
    const sid = `p-${sfx}-2`;
    await report(sid, { status: "waiting", waitReason: "permission", openAsk: { id: "a1", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(x)", inTerminal: true } });
    const r = await answer(sid, "a1");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/waiting in the terminal on ann-mbp/);
    // A deadline that has passed counts the same, even before the reporter says so.
    await report(sid, { status: "waiting", waitReason: "permission", openAsk: { id: "a2", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(y)", answerableUntil: new Date(Date.now() - 10_000).toISOString() } });
    expect((await answer(sid, "a2")).statusCode).toBe(409);
    // Inside the window it goes through.
    await report(sid, { status: "waiting", waitReason: "permission", openAsk: { id: "a3", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(z)", answerableUntil: new Date(Date.now() + 30_000).toISOString() } });
    expect((await answer(sid, "a3")).statusCode).toBe(200);
  });

  it("pushes a waiting prompt to the owner once, with Allow and Deny, and not at all at the desk", async () => {
    const sub = await app.inject({ method: "POST", url: "/api/me/push", headers: { ...H, cookie }, payload: { endpoint: `https://push.example/${sfx}`, keys: { p256dh: "BKeyForTests_0123456789abcdef", auth: "authForTests1234" } } });
    expect(sub.json().pushDevices).toBe(1);
    await prefs({ presence: "auto" });
    sent.length = 0;
    const sid = `p-${sfx}-3`;
    const waiting = { status: "waiting", waitReason: "permission", openAsk: { id: "w1", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(rm -rf build)", detail: { command: "rm -rf build" }, answerableUntil: new Date(Date.now() + 60_000).toISOString() } };
    await report(sid, waiting);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]!.payload).toMatchObject({ kind: "waiting", sessionId: sid, ask: { id: "w1", kind: "permission" }, url: `/app/sessions/${sid}` });
    expect(String(sent[0]!.payload.body)).toContain("rm -rf build");
    expect(String(sent[0]!.payload.body)).toContain("Deletes files");
    // The same prompt reported again is not pushed again.
    await report(sid, waiting);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.length).toBe(1);
    // At the desk: nothing.
    await prefs({ presence: "desk" });
    await report(`p-${sfx}-4`, { ...waiting, openAsk: { ...waiting.openAsk, id: "w2" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.length).toBe(1);
    await prefs({ presence: "auto" });
  });

  it("pushes a summary when a long turn ends, and skips short ones", async () => {
    sent.length = 0;
    const sid = `p-${sfx}-5`;
    const t0 = Date.now() - 5 * 60_000;
    await report(sid, { status: "running", filesChanged: [{ path: "/r/a.ts", status: "modified", added: 10, removed: 2 }] }, [{ id: "t1", ts: new Date(t0).toISOString(), kind: "turn.start", text: "prompt" }]);
    await report(sid, { status: "waiting", waitReason: "idle", filesChanged: [{ path: "/r/a.ts", status: "modified", added: 10, removed: 2 }] }, [{ id: "t2", ts: new Date().toISOString(), kind: "turn.end", text: "turn ended" }]);
    await vi.waitFor(() => expect(sent.some((s) => s.payload.kind === "done")).toBe(true));
    const done = sent.find((s) => s.payload.kind === "done")!.payload;
    expect(done.body).toMatch(/^Finished after 5 min · 1 file changed \(\+10 −2\)/);
    // A ten-second turn is someone at the keyboard: no notification.
    sent.length = 0;
    await report(sid, { status: "running" }, [{ id: "t3", ts: new Date(Date.now() - 10_000).toISOString(), kind: "turn.start", text: "prompt" }]);
    await report(sid, { status: "waiting", waitReason: "idle" }, [{ id: "t4", ts: new Date().toISOString(), kind: "turn.end", text: "turn ended" }]);
    await new Promise((r) => setTimeout(r, 400));
    expect(sent.filter((s) => s.payload.kind === "done")).toEqual([]);
  });

  it("suggests a command people keep approving, and once added the reporter is told to skip the prompt", async () => {
    const sid = `p-${sfx}-6`;
    await report(sid, { status: "running" });
    for (let i = 0; i < 5; i++) {
      await pool.query("INSERT INTO asks (id, org_id, session_id, kind, tool, prompt, created_at, closed_at, answered_by, answer, outcome) VALUES ($1,$2,$3,'permission','Bash',$4, now(), now(), $5, $6, 'answered')", [
        `s${i}`, orgId, sid, `Bash(pnpm test --filter pkg${i})`, uid, JSON.stringify({ decision: "allow" }),
      ]);
    }
    const s = await app.inject({ method: "GET", url: "/api/admin/policy/suggestions", headers: { cookie } });
    expect(s.json().suggestions).toEqual([expect.objectContaining({ key: "Bash(pnpm test:*)", asked: 5, allowedHere: 5 })]);
    const decide = () => app.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { sessionId: sid, tool: "Bash", command: "pnpm test --filter api" } });
    expect((await decide()).json()).toEqual({ decision: "allow", reason: null });
    const version = (await app.inject({ method: "GET", url: "/api/admin/policy", headers: { cookie } })).json().version as number;
    const applied = await app.inject({ method: "POST", url: "/api/admin/policy/suggestions/apply", headers: { ...H, cookie }, payload: { tool: "Bash", content: "pnpm test:*", baseVersion: version } });
    expect(applied.statusCode).toBe(200);
    expect((await decide()).json()).toMatchObject({ decision: "allow", explicit: true });
    // Once a rule decides it, it is no longer suggested.
    const after = await app.inject({ method: "GET", url: "/api/admin/policy/suggestions", headers: { cookie } });
    expect(after.json().suggestions).toEqual([]);
  });
});
