import { clean, evaluatePolicy, PolicyDoc, type DecideRequest, type PolicyRule, type PolicyVerdict, type ToolCall } from "@tessera/contract";
import type { PoolClient } from "pg";
import { pool, withTx } from "../db/pool.js";

export interface ActivePolicy {
  version: number;
  doc: PolicyDoc;
  createdAt: string | null;
  createdByName: string | null;
}

const EMPTY: ActivePolicy = { version: 0, doc: { rules: [] }, createdAt: null, createdByName: null };
const cache = new Map<string, { p: ActivePolicy; until: number }>();

export function invalidatePolicy(orgId: string): void {
  cache.delete(orgId);
}

/** The policy in force for an org (the highest version), cached for 10 s. */
export async function activePolicy(orgId: string): Promise<ActivePolicy> {
  const hit = cache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.p;
  const r = await pool.query<{ version: number; rules: unknown; created_at: string; created_by_name: string }>(
    "SELECT version, rules, created_at, created_by_name FROM policy_versions WHERE org_id = $1 ORDER BY version DESC LIMIT 1",
    [orgId],
  );
  const row = r.rows[0];
  const p: ActivePolicy = row ? { version: row.version, doc: PolicyDoc.parse({ rules: row.rules }), createdAt: row.created_at, createdByName: row.created_by_name } : EMPTY;
  cache.set(orgId, { p, until: Date.now() + 10_000 });
  return p;
}

/** Rule ids must be unique: decisions and the audit log refer to rules by id. */
export function checkRules(doc: PolicyDoc): string | null {
  const seen = new Set<string>();
  for (const r of doc.rules) {
    if (seen.has(r.id)) return `Two rules share the id ${r.id}.`;
    seen.add(r.id);
    const m = r.match;
    const conditions = m.tools.length + m.commands.length + m.paths.length + m.urls.length + m.models.length + m.repos.length + m.branches.length + m.teams.length;
    if (!conditions) return `Rule "${r.name}" matches every tool call. Give it at least one condition (a tool, command, path, URL, model, repo, branch or team).`;
  }
  return null;
}

/** Save a new version; it is in force immediately. */
export async function savePolicy(orgId: string, doc: PolicyDoc, note: string | null, by: { userId: string; name: string }): Promise<number> {
  const version = await withTx(async (c: PoolClient) => {
    // Serialise saves per org so two admins cannot write the same version number.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`policy:${orgId}`]);
    const r = await c.query<{ v: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policy_versions WHERE org_id = $1", [orgId]);
    const v = r.rows[0]!.v;
    await c.query("INSERT INTO policy_versions (org_id, version, rules, note, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6)", [orgId, v, JSON.stringify(doc.rules), note, by.userId, by.name]);
    return v;
  });
  invalidatePolicy(orgId);
  return version;
}

/** The facts the reporter sent, bounded and scrubbed again on the server. */
export function callFrom(req: DecideRequest, session: { cwd: string | null; model: string | null; git: { repo: string | null; branch: string | null } | null; teamId: string | null } | null): ToolCall {
  return {
    tool: req.tool,
    command: req.command ? clean(req.command, 2000) : null,
    paths: (req.paths ?? []).map((p) => clean(p, 400)),
    url: req.url ? clean(req.url, 1000) : null,
    cwd: session?.cwd ?? null,
    model: session?.model ?? null,
    repo: session?.git?.repo ?? null,
    branch: session?.git?.branch ?? null,
    teamId: session?.teamId ?? null,
  };
}

export function summaryOf(call: ToolCall): string {
  const what = call.command ?? call.paths?.[0] ?? call.url ?? "";
  return clean(what ? `${call.tool}(${what})` : call.tool, 300);
}

/** Record every rule that denied, asked, or in dry run would have. Explicit allows are not recorded. */
export async function recordDecisions(orgId: string, sessionId: string, userId: string | null, call: ToolCall, verdict: PolicyVerdict, version: number): Promise<void> {
  const rows: { rule: PolicyRule; enforced: boolean }[] = verdict.dryRun.filter((r) => r.effect !== "allow").map((rule) => ({ rule, enforced: false }));
  if (verdict.rule && verdict.rule.effect !== "allow") rows.push({ rule: verdict.rule, enforced: true });
  if (!rows.length) return;
  const summary = summaryOf(call);
  const values: unknown[] = [];
  const tuples = rows.map(({ rule, enforced }, i) => {
    values.push(orgId, sessionId, userId, call.tool, summary, rule.id, rule.name, rule.effect, enforced, version);
    const b = i * 10;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
  });
  await pool.query(`INSERT INTO policy_decisions (org_id, session_id, user_id, tool, summary, rule_id, rule_name, effect, enforced, version) VALUES ${tuples.join(",")}`, values);
}

export { evaluatePolicy };
