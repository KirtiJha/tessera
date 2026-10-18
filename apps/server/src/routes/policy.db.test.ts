/**
 * Tool-call policy end to end: admins save versioned rules, the reporter's
 * decide call is answered from them, and decisions are recorded.
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

const RULES = [
  { id: "allow-plan", name: "Terraform plan is fine", effect: "allow", match: { tools: ["Bash"], commands: ["terraform plan*"] } },
  { id: "ask-tf", name: "Terraform changes need a reviewer", effect: "ask", reason: "Infra changes are reviewed.", match: { tools: ["Bash"], commands: ["terraform *"] } },
  { id: "env", name: "No secrets files", effect: "deny", reason: "Use the vault.", match: { tools: ["Read", "Edit", "Write"], paths: ["**/.env", ".env.*"] } },
  { id: "web", name: "Web fetches (trial)", effect: "deny", mode: "dry_run", match: { tools: ["WebFetch"] } },
];

describe.skipIf(!reachable)("tool-call policy", () => {
  let app: FastifyInstance;
  let fleet: import("../fleet/fleet.js").Fleet;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let admin = "";
  let operator = "";
  let token = "";
  const sessionId = `pol-${sfx}`;

  const decide = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { sessionId, ...body } });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    const built = await buildApp();
    app = built.server;
    fleet = built.fleet;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Policy Co', $2)", [orgId, `policy-${sfx}`]);
    const pw = await hashPassword("password-12345");
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, 'Ada Admin', 'admin', $4), ($1, $3, 'Otto Operator', 'operator', $4)", [orgId, `admin-${sfx}@policy.test`, `op-${sfx}@policy.test`, pw]);
    const op = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [`op-${sfx}@policy.test`]);
    token = (await issueDevice(orgId, op.rows[0]!.id, "laptop")).token;
    admin = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `admin-${sfx}@policy.test`, password: "password-12345" } }));
    operator = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `op-${sfx}@policy.test`, password: "password-12345" } }));
    // A live session in /repo on main.
    await app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sessionId, status: "running", startedAt: new Date().toISOString(), cwd: "/repo", model: "claude-sonnet-4-5", git: { repo: "acme/infra", branch: "main" } }, events: [] },
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("allows everything until a policy exists", async () => {
    expect((await decide({ tool: "Bash", command: "terraform apply" })).json()).toEqual({ decision: "allow", reason: null });
  });

  it("is for admins only, and refuses rules that match everything or share an id", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/policy", headers: { cookie: operator } })).statusCode).toBe(403);
    const all = await app.inject({ method: "PUT", url: "/api/admin/policy", headers: { ...H, cookie: admin }, payload: { baseVersion: 0, rules: [{ id: "x", name: "Everything", effect: "deny", match: {} }] } });
    expect(all.statusCode).toBe(400);
    expect(all.json().error).toContain("matches every tool call");
    const dup = await app.inject({ method: "PUT", url: "/api/admin/policy", headers: { ...H, cookie: admin }, payload: { baseVersion: 0, rules: [RULES[0], RULES[0]] } });
    expect(dup.json().error).toContain("share the id");
  });

  it("saves a version, and refuses a save based on an older version", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/admin/policy", headers: { ...H, cookie: admin }, payload: { baseVersion: 0, rules: RULES, note: "First rules" } });
    expect(r.json()).toEqual({ ok: true, version: 1 });
    const stale = await app.inject({ method: "PUT", url: "/api/admin/policy", headers: { ...H, cookie: admin }, payload: { baseVersion: 0, rules: [] } });
    expect(stale.statusCode).toBe(409);
    const got = await app.inject({ method: "GET", url: "/api/admin/policy", headers: { cookie: admin } });
    expect(got.json()).toMatchObject({ version: 1, updatedBy: "Ada Admin", versions: [{ version: 1, note: "First rules", rules: 4 }] });
    expect(got.json().rules.map((x: { id: string }) => x.id)).toEqual(["allow-plan", "ask-tf", "env", "web"]);
  });

  it("answers the reporter from the rules, using the session's directory", async () => {
    expect((await decide({ tool: "Bash", command: "terraform plan -out tf.plan" })).json().decision).toBe("allow");
    const ask = (await decide({ tool: "Bash", command: "cd infra && terraform apply" })).json();
    expect(ask).toEqual({ decision: "ask", reason: 'Needs approval by Tessera policy "Terraform changes need a reviewer": Infra changes are reviewed.' });
    const deny = (await decide({ tool: "Read", paths: ["/repo/services/api/.env"] })).json();
    expect(deny.decision).toBe("deny");
    expect(deny.reason).toContain("Use the vault.");
    expect((await decide({ tool: "Edit", paths: ["/repo/.env.production"] })).json().decision).toBe("deny");
    expect((await decide({ tool: "Read", paths: ["/repo/src/env.ts"] })).json().decision).toBe("allow");
    expect((await decide({ tool: "WebFetch", url: "https://example.com" })).json().decision).toBe("allow");
  });

  it("records denials, approvals asked for and dry-run hits, and lists them", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const r = await app.inject({ method: "GET", url: "/api/admin/policy/decisions", headers: { cookie: admin } });
    const rows = r.json().decisions as { ruleId: string; enforced: boolean; userName: string; summary: string }[];
    expect(rows.map((d) => `${d.ruleId}:${d.enforced}`).sort()).toEqual(["ask-tf:true", "env:true", "env:true", "web:false"]);
    expect(rows[0]!.userName).toBe("Otto Operator");
    expect(rows.find((d) => d.ruleId === "web")!.summary).toBe("WebFetch(https://example.com)");
    const hits = (await app.inject({ method: "GET", url: "/api/admin/policy", headers: { cookie: admin } })).json().hits;
    expect(hits).toContainEqual(expect.objectContaining({ ruleId: "env", enforced: true, count: 2 }));
  });

  it("tests a draft without saving it", async () => {
    const draft = [{ id: "push", name: "No pushes to main", effect: "deny", match: { tools: ["Bash"], commands: ["git push*"], branches: ["main"] } }];
    const t = await app.inject({ method: "POST", url: "/api/admin/policy/test", headers: { ...H, cookie: admin }, payload: { rules: draft, call: { tool: "Bash", command: "git push origin HEAD", branch: "main" } } });
    expect(t.json()).toMatchObject({ decision: "deny", rule: { id: "push" } });
    const saved = await app.inject({ method: "POST", url: "/api/admin/policy/test", headers: { ...H, cookie: admin }, payload: { call: { tool: "Bash", command: "git push origin HEAD", branch: "main" } } });
    expect(saved.json().decision).toBe("allow");
  });

  it("audits each save with what changed, and a pause still wins over policy", async () => {
    const next = [RULES[2], { ...RULES[1], reason: "Ask #infra." }];
    const r = await app.inject({ method: "PUT", url: "/api/admin/policy", headers: { ...H, cookie: admin }, payload: { baseVersion: 1, rules: next } });
    expect(r.json().version).toBe(2);
    const a = await pool.query("SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'policy.update' ORDER BY id DESC LIMIT 1", [orgId]);
    expect(a.rows[0]!.detail).toMatchObject({ version: 2, from: 1, removed: ["Terraform plan is fine", "Web fetches (trial)"], changed: ["Terraform changes need a reviewer"], reordered: true, added: [] });
    const v1 = await app.inject({ method: "GET", url: "/api/admin/policy/versions/1", headers: { cookie: admin } });
    expect(v1.json().rules).toHaveLength(4);
    await fleet.setPaused(orgId, sessionId, true, "Investigating", "Ada Admin");
    expect((await decide({ tool: "Read", paths: ["/repo/README.md"] })).json()).toEqual({ decision: "deny", reason: "Session paused in Tessera: Investigating" });
  });
});
