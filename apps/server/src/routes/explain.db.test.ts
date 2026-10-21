/**
 * "Explain this failure": off until an owner turns it on, sends only the
 * failed call's redacted text with DLP applied, answers from a stand-in for
 * the Claude API, keeps the answer so asking twice costs once, and is audited.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The Claude API's stand-in, on a port chosen now: config reads these when it first loads.
const asked: { headers: Record<string, unknown>; body: { model: string; system: string; messages: { content: string }[] } }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { content: [{ type: "text", text: "The test run failed: 2 refund tests expect 3 retries.\nLikely cause: the retry count changed.\nTry: update the tests or the constant." }] } };
const claude: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // Only the explain calls carry a body; anything else reaching the stand-in is not recorded.
    if (raw) asked.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
});
await new Promise<void>((r) => claude.listen(0, "127.0.0.1", () => r()));
process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${(claude.address() as { port: number }).port}`;
process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";

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

describe.skipIf(!reachable)("explaining a failure", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let cookie = "";
  let token = "";
  const sid = `ex-${sfx}`;
  const settings = (data: Record<string, unknown>) => pool.query("UPDATE orgs SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{data}', $2::jsonb) WHERE id = $1", [orgId, JSON.stringify(data)]).then(() => invalidateDataSettings(orgId));
  const explain = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/explain`, headers: { ...H, cookie }, payload: body });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Explain',$2)", [orgId, `explain-${sfx}`]);
    const uid = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Ann','admin',$3) RETURNING id", [orgId, `ann-${sfx}@explain.test`, await hashPassword("password-12345")])).rows[0]!.id;
    cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@explain.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, uid, "ann-mbp")).token;
    const t = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    await app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        v: 1, sentAt: new Date().toISOString(), reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "ann-mbp", machineId: "m" },
        session: {
          id: sid, status: "running", startedAt: t(600), git: { repo: "acme/payments", branch: "main", worktree: null, ahead: 0, behind: 0, modified: 1 },
          activity: [
            { id: "a1", ts: t(60), tool: "Read", summary: "Read(src/refund.ts)", status: "ok", endedAt: t(59), durationMs: 10, error: null },
            { id: "a2", ts: t(30), tool: "Bash", summary: "Bash(pnpm test refunds)", status: "failed", endedAt: t(20), durationMs: 10_000, error: "2 tests failed: expected 3 retries; mail ops@acme.test" },
          ],
        },
        events: [],
      },
    });
  });

  afterAll(async () => {
    await app.close();
    claude.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("is off until an owner turns it on, and says so", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { ...H, cookie } })).json();
    expect(detail.canExplain).toBe(false);
    const r = await explain({ kind: "action", id: "a2" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/turned off for your organisation/);
    expect(asked).toHaveLength(0);
  });

  it("sends the failed call's text with DLP applied, shows the answer, and keeps it", async () => {
    await settings({ explainFailures: true, dlp: { emails: true } });
    expect((await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { ...H, cookie } })).json().canExplain).toBe(true);
    const r = await explain({ kind: "action", id: "a2" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ model: "claude-haiku-5-5", cached: false, text: expect.stringContaining("2 refund tests expect 3 retries") });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.headers["x-api-key"]).toBe("sk-test-not-a-real-key");
    const sent = asked[0]!.body.messages[0]!.content;
    expect(sent).toContain("Tool call: Bash(pnpm test refunds)");
    expect(sent).toContain("Error: 2 tests failed: expected 3 retries; mail [email]");
    expect(sent).toContain("- Read(src/refund.ts): ok");
    expect(sent).not.toContain("ops@acme.test");
    // Asking again is answered from what was kept, and audited once.
    expect((await explain({ kind: "action", id: "a2" })).json().cached).toBe(true);
    expect(asked).toHaveLength(1);
    const audit = await pool.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'session.explain'", [orgId]);
    expect(audit.rowCount).toBe(1);
  });

  it("refuses a step that did not fail, and explains an API refusal in words", async () => {
    expect((await explain({ kind: "action", id: "a1" })).statusCode).toBe(404);
    reply = { status: 401, body: { error: { message: "invalid x-api-key" } } };
    const r = await app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "ann-mbp", machineId: "m" }, session: { id: sid, status: "running", startedAt: new Date(Date.now() - 600_000).toISOString(), activity: [{ id: "a3", ts: new Date().toISOString(), tool: "Bash", summary: "Bash(make)", status: "failed", endedAt: new Date().toISOString(), durationMs: 5, error: "make: *** [all] Error 2" }] }, events: [] },
    });
    expect(r.statusCode).toBe(200);
    const bad = await explain({ kind: "action", id: "a3" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe("The Claude API refused the request (401: invalid x-api-key). Check the server's ANTHROPIC_API_KEY and EXPLAIN_MODEL.");
  });
});
