import { pool } from "../db/pool.js";

export interface Budget {
  id: string;
  orgId: string;
  scopeType: "org" | "team" | "user";
  scopeId: string | null;
  window: "daily" | "weekly" | "monthly";
  softUsd: number | null;
  hardUsd: number | null;
  enforce: boolean;
}

export interface BudgetStatus extends Budget {
  windowStart: string;
  spentUsd: number;
  level: "ok" | "soft" | "hard";
}

function windowStartSql(window: Budget["window"]): string {
  return window === "daily" ? "date_trunc('day', now())" : window === "weekly" ? "date_trunc('week', now())" : "date_trunc('month', now())";
}

const cache = new Map<string, { statuses: BudgetStatus[]; until: number }>();

export function invalidateBudgets(orgId: string): void {
  cache.delete(orgId);
}

export async function listBudgets(orgId: string): Promise<Budget[]> {
  const r = await pool.query(
    `SELECT id, org_id, scope_type, scope_id, "window", soft_usd, hard_usd, enforce FROM budgets WHERE org_id = $1 ORDER BY scope_type, "window"`,
    [orgId],
  );
  return r.rows.map((b) => ({
    id: b.id,
    orgId: b.org_id,
    scopeType: b.scope_type,
    scopeId: b.scope_id,
    window: b.window,
    softUsd: b.soft_usd,
    hardUsd: b.hard_usd,
    enforce: b.enforce,
  }));
}

/** Spend in the window for a scope, from the cumulative per-session cost samples. */
async function spendFor(orgId: string, b: Budget): Promise<{ windowStart: string; spent: number }> {
  const scopeClause = b.scopeType === "team" ? "AND s.team_id = $2" : b.scopeType === "user" ? "AND s.owner_id = $2" : "";
  const params: unknown[] = b.scopeType === "org" ? [orgId] : [orgId, b.scopeId];
  const r = await pool.query<{ window_start: string; spent: number | null }>(
    `WITH w AS (SELECT ${windowStartSql(b.window)} AS start),
     bounds AS (
       SELECT sa.session_id,
              MAX(sa.cost_usd) FILTER (WHERE sa.ts >= w.start) AS end_cost,
              MAX(sa.cost_usd) FILTER (WHERE sa.ts <  w.start) AS start_cost
         FROM samples sa JOIN sessions s ON s.org_id = sa.org_id AND s.id = sa.session_id, w
        WHERE sa.org_id = $1 ${scopeClause} AND sa.ts > w.start - interval '2 days'
        GROUP BY sa.session_id)
     SELECT (SELECT start FROM w) AS window_start,
            SUM(GREATEST(COALESCE(end_cost,0) - COALESCE(start_cost,0), 0)) FILTER (WHERE end_cost IS NOT NULL) AS spent
       FROM bounds`,
    params,
  );
  const row = r.rows[0];
  return { windowStart: row?.window_start ?? new Date().toISOString(), spent: Number(row?.spent ?? 0) };
}

export async function budgetStatuses(orgId: string): Promise<BudgetStatus[]> {
  const hit = cache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.statuses;
  const budgets = await listBudgets(orgId);
  const statuses: BudgetStatus[] = [];
  for (const b of budgets) {
    const { windowStart, spent } = await spendFor(orgId, b);
    const level = b.hardUsd !== null && spent >= b.hardUsd ? "hard" : b.softUsd !== null && spent >= b.softUsd ? "soft" : "ok";
    statuses.push({ ...b, windowStart, spentUsd: spent, level });
  }
  cache.set(orgId, { statuses, until: Date.now() + 15_000 });
  return statuses;
}

/** Budgets that apply to a session's owner, team and org. */
export function applicable(statuses: BudgetStatus[], s: { ownerId: string | null; teamId: string | null }): BudgetStatus[] {
  return statuses.filter(
    (b) => b.scopeType === "org" || (b.scopeType === "team" && b.scopeId === s.teamId) || (b.scopeType === "user" && b.scopeId === s.ownerId),
  );
}

/** Record a breach once per budget, level and window. Returns true when it was new. */
export async function recordBreach(b: BudgetStatus): Promise<boolean> {
  if (b.level === "ok") return false;
  const r = await pool.query(
    `INSERT INTO budget_breaches (org_id, budget_id, level, window_start, spent_usd) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [b.orgId, b.id, b.level, b.windowStart, b.spentUsd],
  );
  return (r.rowCount ?? 0) > 0;
}
