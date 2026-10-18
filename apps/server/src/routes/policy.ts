import { evaluatePolicy, PolicyDoc, PolicyRule } from "@tessera/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { canManageOrg } from "../auth/rbac.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { pool } from "../db/pool.js";
import { activePolicy, checkRules, savePolicy } from "../fleet/policy.js";

function admin(req: FastifyRequest) {
  const p = req.principal!;
  if (!canManageOrg(p)) throw Object.assign(new Error("admin role required"), { statusCode: 403 });
  return p;
}

/** Short, stable description of what changed between two versions, for the audit log. */
function diff(before: PolicyRule[], after: PolicyRule[]): { added: string[]; removed: string[]; changed: string[]; reordered: boolean } {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const added = after.filter((r) => !b.has(r.id)).map((r) => r.name);
  const removed = before.filter((r) => !a.has(r.id)).map((r) => r.name);
  const changed = after.filter((r) => b.has(r.id) && JSON.stringify(b.get(r.id)) !== JSON.stringify(r)).map((r) => r.name);
  const common = (xs: PolicyRule[], other: Map<string, PolicyRule>) => xs.filter((r) => other.has(r.id)).map((r) => r.id).join(",");
  return { added, removed, changed, reordered: common(before, a) !== common(after, b) };
}

const TestCall = z.object({
  tool: z.string().trim().min(1).max(120),
  command: z.string().max(2000).optional(),
  path: z.string().max(400).optional(),
  url: z.string().max(1000).optional(),
  cwd: z.string().max(400).optional(),
  model: z.string().max(120).optional(),
  repo: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  teamId: z.string().uuid().optional(),
});

/** Tool-call policy: admins read, edit, test and roll back; every save is a version. */
export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  app.get("/", async (req) => {
    const p = admin(req);
    const active = await activePolicy(p.orgId);
    const [versions, stats] = await Promise.all([
      pool.query<{ version: number; created_at: string; created_by_name: string; note: string | null; rules: number }>(
        "SELECT version, created_at, created_by_name, note, jsonb_array_length(rules) AS rules FROM policy_versions WHERE org_id = $1 ORDER BY version DESC LIMIT 50",
        [p.orgId],
      ),
      pool.query<{ rule_id: string; effect: string; enforced: boolean; n: number; last: string }>(
        `SELECT rule_id, effect, enforced, COUNT(*)::int AS n, MAX(created_at) AS last FROM policy_decisions
          WHERE org_id = $1 AND created_at > now() - interval '7 days' GROUP BY 1, 2, 3`,
        [p.orgId],
      ),
    ]);
    return {
      version: active.version,
      rules: active.doc.rules,
      updatedAt: active.createdAt,
      updatedBy: active.createdByName,
      versions: versions.rows.map((v) => ({ version: v.version, createdAt: v.created_at, createdBy: v.created_by_name, note: v.note, rules: v.rules })),
      hits: stats.rows.map((s) => ({ ruleId: s.rule_id, effect: s.effect, enforced: s.enforced, count: s.n, last: s.last })),
    };
  });

  app.get("/versions/:version", async (req, reply) => {
    const p = admin(req);
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(req.params);
    const r = await pool.query<{ rules: unknown; created_at: string; created_by_name: string; note: string | null }>("SELECT rules, created_at, created_by_name, note FROM policy_versions WHERE org_id = $1 AND version = $2", [p.orgId, version]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "no such version" });
    return { version, rules: PolicyDoc.parse({ rules: row.rules }).rules, createdAt: row.created_at, createdBy: row.created_by_name, note: row.note };
  });

  app.put("/", async (req, reply) => {
    const p = admin(req);
    const body = z.object({ rules: PolicyDoc.shape.rules, note: z.string().trim().max(300).optional(), baseVersion: z.number().int().min(0) }).parse(req.body);
    const doc: PolicyDoc = { rules: body.rules };
    const problem = checkRules(doc);
    if (problem) return reply.code(400).send({ error: problem });
    const before = await activePolicy(p.orgId);
    // Someone else saved since this editor loaded: refuse rather than silently overwrite their change.
    if (before.version !== body.baseVersion) return reply.code(409).send({ error: `The policy changed since you opened it (now version ${before.version}, by ${before.createdByName ?? "someone"}). Reload to see it.` });
    const version = await savePolicy(p.orgId, doc, body.note ?? null, { userId: p.userId, name: p.name });
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "policy.update", targetType: "policy", targetId: String(version), detail: { version, from: before.version, rules: doc.rules.length, note: body.note ?? null, ...diff(before.doc.rules, doc.rules) }, ip: req.ip });
    return { ok: true, version };
  });

  /** Evaluate a tool call against the saved policy, or against a draft the editor sends. */
  app.post("/test", async (req) => {
    admin(req);
    const p = req.principal!;
    const body = z.object({ rules: PolicyDoc.shape.rules.optional(), call: TestCall }).parse(req.body);
    const doc = body.rules ? { rules: body.rules } : (await activePolicy(p.orgId)).doc;
    const c = body.call;
    const v = evaluatePolicy(doc, { tool: c.tool, command: c.command ?? null, paths: c.path ? [c.path] : [], url: c.url ?? null, cwd: c.cwd ?? null, model: c.model ?? null, repo: c.repo ?? null, branch: c.branch ?? null, teamId: c.teamId ?? null });
    return { decision: v.decision, rule: v.rule ? { id: v.rule.id, name: v.rule.name, effect: v.rule.effect, reason: v.rule.reason } : null, dryRun: v.dryRun.map((r) => ({ id: r.id, name: r.name, effect: r.effect })) };
  });

  app.get("/decisions", async (req) => {
    const p = admin(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), rule: z.string().max(64).optional() }).parse(req.query);
    const params: unknown[] = [p.orgId, q.limit];
    const r = await pool.query(
      `SELECT d.id, d.session_id, d.tool, d.summary, d.rule_id, d.rule_name, d.effect, d.enforced, d.version, d.created_at, u.name AS user_name
         FROM policy_decisions d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.org_id = $1 ${q.rule ? `AND d.rule_id = $${params.push(q.rule)}` : ""}
        ORDER BY d.created_at DESC LIMIT $2`,
      params,
    );
    return {
      decisions: r.rows.map((d) => ({ id: d.id, sessionId: d.session_id, tool: d.tool, summary: d.summary, ruleId: d.rule_id, ruleName: d.rule_name, effect: d.effect, enforced: d.enforced, version: d.version, createdAt: d.created_at, userName: d.user_name })),
    };
  });
}
