import type { Kpis, SessionView } from "@tessera/contract";
import { pool } from "../db/pool.js";

/**
 * KPIs for one org. Live counts come from the derived views in memory; the
 * day's totals and the per-minute series come from the samples and agents
 * tables, so a server restart does not reset them.
 */
export async function computeKpis(orgId: string, live: SessionView[]): Promise<Kpis> {
  const liveSessions = live.filter((s) => s.status !== "ended");
  const waitingSessions = liveSessions.filter((s) => s.status === "waiting" && s.waitReason !== "background" && s.waitReason !== "idle");
  const runningAgents = liveSessions.reduce((n, s) => n + s.agents.filter((a) => a.status === "running" && a.kind !== "orchestrator").length, 0);

  const [series, today, failed, blowouts] = await Promise.all([
    pool.query<{ minute: string; tokens: number; cost: number }>(
      `SELECT date_trunc('minute', ts) AS minute, SUM(tokens_delta)::bigint AS tokens,
              COALESCE(SUM(cost_delta), 0)::numeric AS cost
         FROM (
           SELECT ts, tokens_delta,
                  cost_usd - LAG(cost_usd) OVER (PARTITION BY session_id ORDER BY ts) AS cost_delta
             FROM samples WHERE org_id = $1 AND ts > now() - interval '61 minutes'
         ) x
        WHERE ts > now() - interval '60 minutes'
        GROUP BY 1 ORDER BY 1`,
      [orgId],
    ),
    pool.query<{ cost: number | null }>(
      `WITH bounds AS (
         SELECT session_id,
                MAX(cost_usd) FILTER (WHERE ts >= date_trunc('day', now())) AS end_cost,
                MAX(cost_usd) FILTER (WHERE ts <  date_trunc('day', now())) AS start_cost
           FROM samples WHERE org_id = $1 AND ts > date_trunc('day', now()) - interval '2 days'
          GROUP BY session_id)
       SELECT SUM(GREATEST(COALESCE(end_cost, 0) - COALESCE(start_cost, 0), 0)) AS cost FROM bounds WHERE end_cost IS NOT NULL`,
      [orgId],
    ),
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agents WHERE org_id = $1 AND status = 'failed' AND ended_at >= date_trunc('day', now())`,
      [orgId],
    ),
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM events WHERE org_id = $1 AND kind = 'context.blowout' AND ts >= date_trunc('day', now())`,
      [orgId],
    ),
  ]);

  const byMinute = new Map(series.rows.map((r) => [Date.parse(r.minute), r]));
  const tokensPerMinute: number[] = [];
  const costPerMinuteUsd: number[] = [];
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  for (let i = 59; i >= 0; i--) {
    const row = byMinute.get(nowMinute - i * 60_000);
    tokensPerMinute.push(row ? Number(row.tokens) : 0);
    costPerMinuteUsd.push(row ? Math.max(0, Number(row.cost)) : 0);
  }

  return {
    liveSessions: liveSessions.length,
    waitingSessions: waitingSessions.length,
    runningAgents,
    failedAgentsToday: failed.rows[0]?.n ?? 0,
    costTodayUsd: Number(today.rows[0]?.cost ?? 0),
    tokensPerMinute,
    costPerMinuteUsd,
    blowoutsToday: blowouts.rows[0]?.n ?? 0,
    unpricedSessions: liveSessions.filter((s) => s.unpricedModels.length > 0).length,
  };
}
