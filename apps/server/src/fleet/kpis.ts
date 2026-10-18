import type { Kpis, SessionView } from "@tessera/contract";
import { pool } from "../db/pool.js";

/**
 * KPIs for one org. Live counts come from the derived views in memory; the
 * day's totals and the per-minute series come from the samples and agents
 * tables, so a server restart does not reset them.
 */
interface Stored {
  series: { tokensPerMinute: number[]; costPerMinuteUsd: number[]; until: number } | null;
  day: { costTodayUsd: number; failedAgentsToday: number; blowoutsToday: number; until: number } | null;
  inflight: Promise<void> | null;
}
const cache = new Map<string, Stored>();
/** The per-minute series moves once a minute; refresh it every 5 s. Day totals every 15 s. */
const SERIES_TTL_MS = 5_000;
const DAY_TTL_MS = 15_000;

export async function computeKpis(orgId: string, live: SessionView[]): Promise<Kpis> {
  const liveSessions = live.filter((s) => s.status !== "ended");
  const waitingSessions = liveSessions.filter((s) => s.status === "waiting" && s.waitReason !== "background" && s.waitReason !== "idle");
  const runningAgents = liveSessions.reduce((n, s) => n + s.agents.filter((a) => a.status === "running" && a.kind !== "orchestrator").length, 0);

  let c = cache.get(orgId);
  if (!c) cache.set(orgId, (c = { series: null, day: null, inflight: null }));
  const now = Date.now();
  const stale = !c.series || c.series.until < now || !c.day || c.day.until < now;
  // One refresh at a time per org; callers during a refresh get the previous values.
  if (stale && !c.inflight) c.inflight = refresh(orgId, c).finally(() => (c!.inflight = null));
  if (!c.series || !c.day) await c.inflight;

  return {
    liveSessions: liveSessions.length,
    waitingSessions: waitingSessions.length,
    runningAgents,
    failedAgentsToday: c.day?.failedAgentsToday ?? 0,
    costTodayUsd: c.day?.costTodayUsd ?? 0,
    tokensPerMinute: c.series?.tokensPerMinute ?? Array(60).fill(0),
    costPerMinuteUsd: c.series?.costPerMinuteUsd ?? Array(60).fill(0),
    blowoutsToday: c.day?.blowoutsToday ?? 0,
    unpricedSessions: liveSessions.filter((s) => s.unpricedModels.length > 0).length,
  };
}

async function refresh(orgId: string, c: Stored): Promise<void> {
  const now = Date.now();
  const needSeries = !c.series || c.series.until < now;
  const needDay = !c.day || c.day.until < now;
  if (needSeries) c.series = { ...(await querySeries(orgId)), until: now + SERIES_TTL_MS };
  if (needDay) c.day = { ...(await queryDay(orgId)), until: now + DAY_TTL_MS };
}

async function querySeries(orgId: string): Promise<{ tokensPerMinute: number[]; costPerMinuteUsd: number[] }> {
  const series = await pool.query<{ minute: string; tokens: number; cost: number }>(
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
  );
  const byMinute = new Map(series.rows.map((r) => [Date.parse(r.minute), r]));
  const tokensPerMinute: number[] = [];
  const costPerMinuteUsd: number[] = [];
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  for (let i = 59; i >= 0; i--) {
    const row = byMinute.get(nowMinute - i * 60_000);
    tokensPerMinute.push(row ? Number(row.tokens) : 0);
    costPerMinuteUsd.push(row ? Math.max(0, Number(row.cost)) : 0);
  }

  return { tokensPerMinute, costPerMinuteUsd };
}

async function queryDay(orgId: string): Promise<{ costTodayUsd: number; failedAgentsToday: number; blowoutsToday: number }> {
  const [today, failed, blowouts] = await Promise.all([
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
  return {
    costTodayUsd: Number(today.rows[0]?.cost ?? 0),
    failedAgentsToday: failed.rows[0]?.n ?? 0,
    blowoutsToday: blowouts.rows[0]?.n ?? 0,
  };
}
