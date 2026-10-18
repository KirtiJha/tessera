/**
 * Informed approvals: what the reporter attaches to a prompt reaches the
 * console scrubbed, the last tool calls travel with the session, an answer can
 * carry a session-wide rule, and multiple-choice questions can be answered by
 * question. Also what a chat message says about the prompt.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { issueDevice } from "../auth/devices.js";
import { waitingText } from "../fleet/fleet.js";
import type { SessionRecord } from "../fleet/types.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe("waitingText", () => {
  const rec = (over: Partial<SessionRecord>): SessionRecord => ({ cwd: "/r", openAsk: null, waitReason: "permission", activity: [], ...over }) as SessionRecord;
  it("shows the command, the agent's reason, the risk and the policy", () => {
    const text = waitingText(rec({ openAsk: { id: "a", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(terraform apply)", options: [], detail: { command: "terraform apply -auto-approve", description: null, edits: [], write: null, url: null, paths: [], rationale: "Applying the staging change.", forcedBy: "Infra needs a look.", suggestedRules: [], questions: [] } } }));
    expect(text).toBe("`terraform apply -auto-approve`\n_Applying the staging change._\n⚠ Changes infrastructure\nPolicy: Infra needs a look.");
    expect(waitingText(rec({ waitReason: "question" }))).toBe("Reason: question");
  });
});

describe.skipIf(!reachable)("informed approvals", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let cookie = "";
  let token = "";
  const sid = `apv-${sfx}`;
  const base = { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, events: [] as unknown[] };
  const report = (session: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...base, session: { id: sid, startedAt: new Date().toISOString(), cwd: "/r", ...session } } });
  const deliveries = async () => (await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries`, headers: { authorization: `Bearer ${token}` } })).json().deliveries as { kind: string; askId: string; payload: Record<string, unknown> }[];

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Apv',$2)", [orgId, `apv-${sfx}`]);
    const uid = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Ann','admin',$3) RETURNING id", [orgId, `ann-${sfx}@apv.test`, await hashPassword("password-12345")])).rows[0]!.id;
    cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@apv.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, uid, "ann-laptop")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("carries the prompt's detail and the recent actions to the console, scrubbed", async () => {
    const r = await report({
      status: "waiting",
      waitReason: "permission",
      activity: [
        { id: "t1", ts: new Date(Date.now() - 5000).toISOString(), tool: "Read", summary: "Read(/r/src/db.ts)", status: "ok", endedAt: new Date().toISOString(), durationMs: 12 },
        { id: "t2", ts: new Date().toISOString(), tool: "Bash", summary: "Bash(pnpm db:migrate)", status: "running" },
      ],
      openAsk: {
        id: "ask-1", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(pnpm db:migrate)",
        detail: { command: "DATABASE_URL=postgres://u:hunter2secret@db/x pnpm db:migrate", description: "Run migrations", rationale: "The schema needs the new column first.", suggestedRules: [{ tool: "Bash", content: "pnpm db:migrate:*" }] },
      },
    });
    expect(r.statusCode).toBe(200);
    const s = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { cookie } })).json().session;
    expect(s.activity.map((a: { summary: string; status: string }) => [a.summary, a.status])).toEqual([["Read(/r/src/db.ts)", "ok"], ["Bash(pnpm db:migrate)", "running"]]);
    expect(s.openAsk.detail.command).toBe("DATABASE_URL=[redacted]db/x pnpm db:migrate");
    expect(s.openAsk.detail.rationale).toBe("The schema needs the new column first.");
    expect(s.openAsk.detail.suggestedRules).toEqual([{ tool: "Bash", content: "pnpm db:migrate:*" }]);
    // The row survives a reload from the database too.
    const row = await pool.query<{ activity: unknown[] }>("SELECT activity FROM sessions WHERE org_id = $1 AND id = $2", [orgId, sid]);
    expect(row.rows[0]!.activity).toHaveLength(2);
  });

  it("delivers an allow with a session rule, and records the rule in the audit log", async () => {
    const a = await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie }, payload: { askId: "ask-1", decision: "allow", scope: "session", rule: { tool: "Bash", content: "pnpm db:migrate:*" } } });
    expect(a.statusCode).toBe(200);
    const d = await deliveries();
    expect(d).toEqual([expect.objectContaining({ kind: "answer", askId: "ask-1", payload: expect.objectContaining({ decision: "allow", scope: "session", rule: { tool: "Bash", content: "pnpm db:migrate:*" } }) })]);
    const audit = await pool.query<{ detail: { sessionRule?: string; command?: string } }>("SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'session.answer.allow' ORDER BY id DESC LIMIT 1", [orgId]);
    expect(audit.rows[0]!.detail.sessionRule).toBe("Bash(pnpm db:migrate:*)");
    expect(audit.rows[0]!.detail.command).toContain("pnpm db:migrate");
  });

  it("ignores a rule on a one-off allow or a deny", async () => {
    await report({ status: "waiting", waitReason: "permission", openAsk: { id: "ask-2", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(rm -rf dist)", detail: { command: "rm -rf dist" } } });
    await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie }, payload: { askId: "ask-2", decision: "deny", scope: "session", rule: { tool: "Bash", content: "rm:*" }, text: "no" } });
    const d = await deliveries();
    expect(d[0]!.payload).toEqual(expect.objectContaining({ decision: "deny", scope: "once", text: "no" }));
    expect(d[0]!.payload.rule).toBeUndefined();
  });

  it("answers multiple-choice questions by question text", async () => {
    await report({
      status: "waiting", waitReason: "question",
      openAsk: { id: "ask-q", kind: "question", createdAt: new Date().toISOString(), tool: "AskUserQuestion", prompt: "1. Which framework?\n2. Which test runner?", options: [], detail: { questions: [{ question: "Which framework?", header: "Framework", options: [{ label: "React" }, { label: "Vue" }] }, { question: "Which test runner?", options: [{ label: "vitest" }, { label: "jest" }], multiSelect: false }] } },
    });
    const s = (await app.inject({ method: "GET", url: `/api/fleet/sessions/${sid}`, headers: { cookie } })).json().session;
    expect(s.openAsk.detail.questions).toHaveLength(2);
    const a = await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie }, payload: { askId: "ask-q", decision: "answer", answers: { "Which framework?": "React", "Which test runner?": "vitest" } } });
    expect(a.statusCode).toBe(200);
    const d = await deliveries();
    expect(d[0]!.payload.answers).toEqual({ "Which framework?": "React", "Which test runner?": "vitest" });
  });
});
