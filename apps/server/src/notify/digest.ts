import { pool } from "../db/pool.js";
import { rollupDays, utcDay } from "../fleet/rollup.js";
import { outlier } from "../fleet/spend.js";
import { notify, type Notification } from "./notifier.js";

/**
 * Two notifications made from the daily spend rollup rather than from one
 * session: the weekly digest (Mondays, for the seven days before) and the spend
 * alert (a day far above the two weeks before, for the organisation and for
 * each team). Both are sent to the channels that chose them, once: the
 * notification log's dedupe key carries the week or the day.
 */

const DAY = 86_400_000;
/** The digest goes out on Monday from this UTC hour, for the Monday-to-Sunday week before. */
export const DIGEST_HOUR_UTC = 8;

const usd = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : `$${n.toFixed(2)}`);
const pct = (now: number, before: number) => (before > 0 ? `${now >= before ? "+" : "−"}${Math.round((Math.abs(now - before) / before) * 100)}%` : now > 0 ? "new" : "flat");
const mins = (ms: number | null) => (ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** ISO week label of a date, "2026-W43". */
export function isoWeek(t: number): string {
  const d = new Date(t);
  // The Thursday of this week decides its year and number.
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (4 - (d.getUTCDay() || 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The week just ended, for a digest made at `now`: the Monday to Sunday before `now`'s week. */
export function lastWeek(now: number): { from: string; to: string; label: string } {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  const from = monday - 7 * DAY;
  return { from: utcDay(from), to: utcDay(monday - DAY), label: isoWeek(from) };
}

export async function weeklyDigest(orgId: string, now = Date.now()): Promise<Notification> {
  const { from, to, label } = lastWeek(now);
  const prevFrom = utcDay(Date.parse(from) - 7 * DAY);
  const prevTo = utcDay(Date.parse(from) - DAY);
  const spend = (a: string, b: string) =>
    pool.query<{ cost: string | null; sessions: number; people: number }>(
      `SELECT SUM(u.cost_usd) AS cost, COUNT(DISTINCT u.session_id)::int AS sessions, COUNT(DISTINCT s.owner_id)::int AS people
         FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date`,
      [orgId, a, b],
    );
  const [cur, prev, teams, top, asks, agents] = await Promise.all([
    spend(from, to),
    spend(prevFrom, prevTo),
    pool.query<{ name: string; cost: string; prev: string | null }>(
      `SELECT COALESCE(t.name, 'No team') AS name, SUM(u.cost_usd) FILTER (WHERE u.day BETWEEN $2::date AND $3::date) AS cost,
              SUM(u.cost_usd) FILTER (WHERE u.day BETWEEN $4::date AND $5::date) AS prev
         FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id LEFT JOIN teams t ON t.id = s.team_id
        WHERE u.org_id = $1 AND u.day BETWEEN $4::date AND $3::date GROUP BY 1 HAVING SUM(u.cost_usd) FILTER (WHERE u.day BETWEEN $2::date AND $3::date) > 0 ORDER BY 2 DESC LIMIT 3`,
      [orgId, from, to, prevFrom, prevTo],
    ),
    pool.query<{ name: string | null; owner: string | null; cost: string }>(
      `SELECT COALESCE(s.name, s.git->>'repo', s.cwd) AS name, o.name AS owner, SUM(u.cost_usd) AS cost
         FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id LEFT JOIN users o ON o.id = s.owner_id
        WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date GROUP BY s.id, s.name, s.git, s.cwd, o.name ORDER BY 3 DESC LIMIT 3`,
      [orgId, from, to],
    ),
    pool.query<{ n: number; answered: number; p50: number | null }>(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE outcome = 'answered')::int AS answered,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (closed_at - created_at))) * 1000)::float AS p50
         FROM asks WHERE org_id = $1 AND created_at >= $2::date AND created_at < ($3::date + 1)`,
      [orgId, from, to],
    ),
    pool.query<{ failed: number; blowouts: number }>(
      `SELECT COALESCE(SUM((SELECT COUNT(*) FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.status = 'failed')), 0)::int AS failed,
              COALESCE(SUM(s.blowouts), 0)::int AS blowouts
         FROM sessions s WHERE s.org_id = $1 AND s.started_at >= $2::date AND s.started_at < ($3::date + 1)`,
      [orgId, from, to],
    ),
  ]);
  const c = cur.rows[0]!;
  const cost = Number(c.cost ?? 0);
  const before = Number(prev.rows[0]?.cost ?? 0);
  const a = asks.rows[0]!;
  const lines = [
    `${c.sessions} session${c.sessions === 1 ? "" : "s"} by ${c.people} ${c.people === 1 ? "person" : "people"} cost ${usd(cost)} (${pct(cost, before)} on the week before, ${usd(before)}).`,
    teams.rows.length ? `Teams: ${teams.rows.map((t) => `${t.name} ${usd(Number(t.cost))} (${pct(Number(t.cost), Number(t.prev ?? 0))})`).join(", ")}.` : null,
    top.rows.length ? `Costliest sessions: ${top.rows.map((s) => `${s.name ?? "unnamed"}${s.owner ? ` (${s.owner})` : ""} ${usd(Number(s.cost))}`).join("; ")}.` : null,
    a.n ? `${a.n} prompt${a.n === 1 ? "" : "s"} waited on people, ${a.answered} answered in Tessera; half were settled within ${mins(a.p50)}.` : "No prompt waited on a person.",
    agents.rows[0]!.failed || agents.rows[0]!.blowouts ? `${agents.rows[0]!.failed} agent${agents.rows[0]!.failed === 1 ? "" : "s"} failed and context windows overflowed ${agents.rows[0]!.blowouts} time${agents.rows[0]!.blowouts === 1 ? "" : "s"}.` : null,
  ].filter(Boolean);
  return {
    event: "digest.weekly",
    dedupeKey: `digest:${label}`,
    title: `Tessera week ${label.slice(-3)}: ${usd(cost)} (${pct(cost, before)})`,
    text: lines.join("\n"),
    fields: { Week: `${from} to ${to}`, Spend: usd(cost), Sessions: String(c.sessions), People: String(c.people) },
    path: `/app/analytics?from=${from}&to=${to}`,
    severity: "info",
  };
}

/**
 * Days whose spend is far out of line, for the organisation and each team:
 * yesterday once it is complete, and today as soon as it has already crossed
 * the line. One alert per scope and day.
 */
export async function spendAlerts(orgId: string, now = Date.now()): Promise<Notification[]> {
  const today = utcDay(now);
  const first = utcDay(now - 15 * DAY);
  const r = await pool.query<{ team_id: string | null; team: string | null; day: string; cost: string }>(
    `SELECT s.team_id, t.name AS team, to_char(u.day, 'YYYY-MM-DD') AS day, SUM(u.cost_usd) AS cost
       FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id LEFT JOIN teams t ON t.id = s.team_id
      WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date GROUP BY 1, 2, 3`,
    [orgId, first, today],
  );
  const scopes = new Map<string, { name: string; teamId: string | null; byDay: Map<string, number> }>();
  const add = (k: string, name: string, teamId: string | null, day: string, v: number) => {
    const sc = scopes.get(k) ?? { name, teamId, byDay: new Map() };
    sc.byDay.set(day, (sc.byDay.get(day) ?? 0) + v);
    scopes.set(k, sc);
  };
  for (const row of r.rows) {
    add("org", "The organisation", null, row.day, Number(row.cost));
    if (row.team_id) add(`team:${row.team_id}`, row.team ?? "A team", row.team_id, row.day, Number(row.cost));
  }
  const out: Notification[] = [];
  for (const [k, sc] of scopes) {
    for (const day of [utcDay(now - DAY), today]) {
      const window = Array.from({ length: 14 }, (_, i) => sc.byDay.get(utcDay(Date.parse(day) - (14 - i) * DAY)) ?? 0);
      const v = sc.byDay.get(day) ?? 0;
      const hit = outlier(window, v);
      if (!hit) continue;
      const when = day === today ? "so far today" : `on ${day}`;
      out.push({
        event: "spend.anomaly",
        dedupeKey: `anomaly:${k}:${day}`,
        title: `${sc.name} spent ${usd(v)} ${when}`,
        text: `That is ${(v / Math.max(0.01, hit.mean)).toFixed(1)} times the daily average of the two weeks before (${usd(hit.mean)}), far outside the usual day-to-day range. Analytics shows which sessions it went on.`,
        fields: { Day: day, Spend: usd(v), "Two-week average": usd(hit.mean), ...(sc.teamId ? { Team: sc.name } : {}) },
        path: sc.teamId ? `/app/teams/${sc.teamId}` : `/app/analytics?from=${day}&to=${day}`,
        severity: "warning",
      });
    }
  }
  return out;
}

interface Log {
  warn: (o: object, m: string) => void;
}

/** Once an hour: the digest on Monday mornings, spend alerts always, for every organisation that has a channel for them. */
export async function runScheduled(log: Log, now = Date.now()): Promise<void> {
  const orgs = await pool.query<{ org_id: string; digest: boolean; anomaly: boolean }>(
    `SELECT org_id, bool_or(events ? 'digest.weekly') AS digest, bool_or(events ? 'spend.anomaly') AS anomaly
       FROM notification_channels WHERE enabled AND events ?| ARRAY['digest.weekly', 'spend.anomaly'] GROUP BY org_id`,
  );
  if (!orgs.rows.length) return;
  // Today's figures come from the samples, rolled up each hour here so an alert can fire the same day.
  await rollupDays(utcDay(now - DAY), utcDay(now));
  const d = new Date(now);
  const digestDue = d.getUTCDay() === 1 && d.getUTCHours() >= DIGEST_HOUR_UTC;
  for (const o of orgs.rows) {
    try {
      if (o.digest && digestDue) await notify(o.org_id, await weeklyDigest(o.org_id, now), log);
      if (o.anomaly) for (const n of await spendAlerts(o.org_id, now)) await notify(o.org_id, n, log);
    } catch (e) {
      log.warn({ org: o.org_id, err: (e as Error).message }, "scheduled notification failed");
    }
  }
}
