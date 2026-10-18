import { pool } from "../db/pool.js";

/**
 * Roll per-minute samples up into cost and tokens per session per UTC day.
 * A sample's cost is cumulative, so a day's cost is the rise across that day's
 * samples, measured from the last sample before the window (which may be days
 * earlier for a session left open). Rewriting a day is idempotent, so running
 * this from several replicas, or twice, gives the same rows.
 */
export async function rollupDays(fromDay: string, toDay: string): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // One rollup at a time across replicas; others skip rather than queue.
    const got = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(7342002) AS ok");
    if (!got.rows[0]?.ok) {
      await c.query("ROLLBACK");
      return 0;
    }
    const r = await c.query(
      `WITH win AS (
         SELECT x.org_id, x.session_id, x.ts, x.tokens_delta,
                GREATEST(COALESCE(x.cost_usd, 0) - COALESCE(
                  LAG(x.cost_usd) OVER (PARTITION BY x.org_id, x.session_id ORDER BY x.ts),
                  (SELECT p.cost_usd FROM samples p WHERE p.org_id = x.org_id AND p.session_id = x.session_id AND p.ts < ($1::date::timestamp AT TIME ZONE 'UTC') ORDER BY p.ts DESC LIMIT 1),
                  0), 0) AS cost_delta
           FROM samples x
          WHERE x.ts >= ($1::date::timestamp AT TIME ZONE 'UTC') AND x.ts < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
       )
       INSERT INTO usage_daily (org_id, session_id, day, tokens, cost_usd)
       SELECT org_id, session_id, (ts AT TIME ZONE 'UTC')::date, SUM(tokens_delta), SUM(cost_delta)
         FROM win GROUP BY 1, 2, 3
       ON CONFLICT (org_id, session_id, day) DO UPDATE SET tokens = EXCLUDED.tokens, cost_usd = EXCLUDED.cost_usd`,
      [fromDay, toDay],
    );
    await c.query("COMMIT");
    return r.rowCount ?? 0;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
