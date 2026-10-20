import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { canManageOrg } from "../auth/rbac.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { pool } from "../db/pool.js";
import { rollupDays, utcDay } from "../fleet/rollup.js";
import { anomalies } from "../fleet/spend.js";

export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-[0-9]+";
const GROUPS = ["team", "cost_center", "person", "repo", "ticket", "model"] as const;

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
  groupBy: z.string().regex(/^(team|cost_center|person|repo|ticket|model|tag:[A-Za-z0-9_.-]{1,60})$/).default("team"),
  team: z.string().uuid().optional(),
});

function range(q: z.infer<typeof Range>): { from: string; to: string; days: number } {
  const to = q.to ?? utcDay(Date.now());
  const from = q.from ?? utcDay(Date.parse(to) - ((q.days ?? 30) - 1) * 86_400_000);
  // Real calendar dates only: "2026-02-31" parses to NaN or rolls over, either way it is refused.
  for (const d of [from, to]) if (!Number.isFinite(Date.parse(d)) || utcDay(Date.parse(d)) !== d) throw Object.assign(new Error(`${d} is not a date.`), { statusCode: 400 });
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > 366) throw Object.assign(new Error("The range must be between 1 and 366 days."), { statusCode: 400 });
  return { from, to, days };
}

/** SQL for the allocation key of a session; $n parameters are appended to `params`. */
function groupExpr(groupBy: string, params: unknown[], ticketPattern: string): string {
  switch (groupBy) {
    case "team":
      return "COALESCE(t.name, 'No team')";
    case "cost_center":
      return "COALESCE(NULLIF(t.cost_center, ''), 'Unallocated')";
    case "person":
      return "COALESCE(o.name, 'Unknown')";
    case "repo":
      return "COALESCE(s.git->>'repo', 'No repository')";
    case "model":
      return "COALESCE(s.model, 'unknown')";
    case "ticket":
      return `COALESCE(NULLIF(s.tags->>'ticket', ''), substring(s.git->>'branch' from $${params.push(ticketPattern)}), 'No ticket')`;
    default: {
      const key = groupBy.slice(4);
      return `COALESCE(NULLIF(s.tags->>$${params.push(key)}, ''), 'Untagged')`;
    }
  }
}

async function ticketPatternFor(orgId: string): Promise<string> {
  const r = await pool.query<{ p: string | null }>("SELECT settings->>'ticketPattern' AS p FROM orgs WHERE id = $1", [orgId]);
  return r.rows[0]?.p || DEFAULT_TICKET_PATTERN;
}

let lastTodayRollup = 0;
/** Keep today's figures within a minute of the samples. */
async function freshen(): Promise<void> {
  if (Date.now() - lastTodayRollup < 60_000) return;
  lastTodayRollup = Date.now();
  await rollupDays(utcDay(Date.now()), utcDay(Date.now()));
}

export { anomalies } from "../fleet/spend.js";

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ is data, not a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** Spend analytics, allocation settings and chargeback export. */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });
  const admin = (req: FastifyRequest) => {
    const p = req.principal!;
    if (!canManageOrg(p)) throw Object.assign(new Error("admin role required"), { statusCode: 403 });
    return p;
  };

  app.get("/", async (req) => {
    const p = req.principal!;
    const q = Range.parse(req.query);
    const { from, to, days } = range(q);
    await freshen().catch((e) => req.log.warn({ err: e }, "rollup failed"));
    const pattern = await ticketPatternFor(p.orgId);

    const base: unknown[] = [p.orgId, from, to];
    const teamFilter = q.team ? ` AND s.team_id = $${base.push(q.team)}` : "";
    const key = groupExpr(q.groupBy, base, pattern);
    const FROM = `FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id
                  LEFT JOIN teams t ON t.id = s.team_id AND t.org_id = s.org_id LEFT JOIN users o ON o.id = s.owner_id
                 WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date${teamFilter}`;

    const prevFrom = utcDay(Date.parse(from) - days * 86_400_000);
    const prevTo = utcDay(Date.parse(from) - 86_400_000);
    // Team and person groups carry their id, so the console can open the team's or the person's page.
    const idExpr = q.groupBy === "team" ? "t.id::text" : q.groupBy === "person" ? "o.id::text" : "NULL::text";
    // The same groups over the period of the same length just before, for the change column.
    const prevBase = [...base];
    prevBase[1] = prevFrom;
    prevBase[2] = prevTo;
    const sessFilter = q.team ? " AND s.team_id = $4" : "";
    const sessParams = q.team ? [p.orgId, from, to, q.team] : [p.orgId, from, to];

    const [daily, groups, totals, prev, agentStats, asks, models, prevGroups] = await Promise.all([
      pool.query<{ day: string; cost: string; tokens: string; sessions: number }>(
        `SELECT to_char(u.day, 'YYYY-MM-DD') AS day, SUM(u.cost_usd) AS cost, SUM(u.tokens) AS tokens, COUNT(DISTINCT u.session_id)::int AS sessions ${FROM} GROUP BY u.day ORDER BY u.day`,
        base.slice(0, q.team ? 4 : 3),
      ),
      pool.query<{ key: string; id: string | null; cost: string; tokens: string; sessions: number; people: number }>(
        `SELECT ${key} AS key, ${idExpr} AS id, SUM(u.cost_usd) AS cost, SUM(u.tokens) AS tokens, COUNT(DISTINCT u.session_id)::int AS sessions, COUNT(DISTINCT s.owner_id)::int AS people
           ${FROM} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 200`,
        base,
      ),
      pool.query<{ cost: string | null; tokens: string | null; sessions: number; people: number }>(
        `SELECT SUM(u.cost_usd) AS cost, SUM(u.tokens) AS tokens, COUNT(DISTINCT u.session_id)::int AS sessions, COUNT(DISTINCT s.owner_id)::int AS people ${FROM}`,
        base.slice(0, q.team ? 4 : 3),
      ),
      pool.query<{ cost: string | null }>(
        `SELECT SUM(u.cost_usd) AS cost FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id
          WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date${sessFilter}`,
        q.team ? [p.orgId, prevFrom, prevTo, q.team] : [p.orgId, prevFrom, prevTo],
      ),
      pool.query<{ agents: number; failed: number; blowouts: number }>(
        `SELECT COALESCE(SUM((SELECT COUNT(*) FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.kind <> 'orchestrator')), 0)::int AS agents,
                COALESCE(SUM((SELECT COUNT(*) FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.status = 'failed')), 0)::int AS failed,
                COALESCE(SUM(s.blowouts), 0)::int AS blowouts
           FROM sessions s WHERE s.org_id = $1 AND s.started_at >= $2::date AND s.started_at < ($3::date + 1)${sessFilter}`,
        sessParams,
      ),
      pool.query<{ total: number; answered: number; slack: number; mean_ms: number | null }>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE a.outcome = 'answered')::int AS answered,
                COUNT(*) FILTER (WHERE a.outcome = 'answered' AND a.answer->>'via' = 'slack')::int AS slack,
                (AVG(EXTRACT(EPOCH FROM (a.closed_at - a.created_at)) * 1000) FILTER (WHERE a.closed_at IS NOT NULL))::float AS mean_ms
           FROM asks a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id
          WHERE a.org_id = $1 AND a.created_at >= $2::date AND a.created_at < ($3::date + 1)${sessFilter}`,
        sessParams,
      ),
      pool.query<{ model: string; cost: string; sessions: number }>(
        `SELECT COALESCE(s.model, 'unknown') AS model, SUM(u.cost_usd) AS cost, COUNT(DISTINCT u.session_id)::int AS sessions ${FROM} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
        base.slice(0, q.team ? 4 : 3),
      ),
      pool.query<{ key: string; cost: string }>(`SELECT ${key} AS key, SUM(u.cost_usd) AS cost ${FROM} GROUP BY 1`, prevBase),
    ]);
    const prevByKey = new Map(prevGroups.rows.map((g) => [g.key, Number(g.cost)]));

    // What the sessions did, who they waited on, and when they ran.
    const inRange = `s.org_id = $1 AND s.started_at >= $2::date AND s.started_at < ($3::date + 1)${sessFilter}`;
    const [tools, toolFails, waits, answerers, hours, cache, topSessions] = await Promise.all([
      pool.query<{ tool: string; calls: string }>(
        `SELECT kv.key AS tool, SUM(kv.value::numeric)::bigint AS calls FROM (
           SELECT s.tool_calls AS tc FROM sessions s WHERE ${inRange}
           UNION ALL
           SELECT a.tool_calls FROM agents a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id WHERE ${inRange}
         ) x, jsonb_each_text(x.tc) AS kv WHERE kv.value ~ '^[0-9]+$' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
        sessParams,
      ),
      pool.query<{ tool: string | null; fails: number }>(
        `SELECT substring(e.text from '^([A-Za-z_][A-Za-z0-9_.:-]*)') AS tool, COUNT(*)::int AS fails
           FROM events e JOIN sessions s ON s.org_id = e.org_id AND s.id = e.session_id
          WHERE e.kind = 'tool.fail' AND e.ts >= $2::date AND e.ts < ($3::date + 1) AND ${inRange} GROUP BY 1`,
        sessParams,
      ),
      pool.query<{ kind: string; n: number; p50: number | null; p90: number | null; max: number | null; open: number }>(
        `SELECT a.kind, COUNT(*)::int AS n,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS p50,
                (percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS p90,
                (MAX(EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS max,
                COUNT(*) FILTER (WHERE a.closed_at IS NULL)::int AS open
           FROM asks a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id
          WHERE a.created_at >= $2::date AND a.created_at < ($3::date + 1) AND ${inRange.replace("s.started_at >= $2::date AND s.started_at < ($3::date + 1)", "TRUE")} GROUP BY a.kind ORDER BY 2 DESC`,
        sessParams,
      ),
      pool.query<{ name: string; n: number; p50: number | null }>(
        `SELECT u.name, COUNT(*)::int AS n, (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS p50
           FROM asks a JOIN users u ON u.id = a.answered_by JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id
          WHERE a.outcome = 'answered' AND a.created_at >= $2::date AND a.created_at < ($3::date + 1) AND ${inRange.replace("s.started_at >= $2::date AND s.started_at < ($3::date + 1)", "TRUE")} GROUP BY u.name ORDER BY 2 DESC LIMIT 8`,
        sessParams,
      ),
      pool.query<{ dow: number; hour: number; n: number }>(`SELECT EXTRACT(ISODOW FROM s.started_at)::int AS dow, EXTRACT(HOUR FROM s.started_at)::int AS hour, COUNT(*)::int AS n FROM sessions s WHERE ${inRange} GROUP BY 1, 2`, sessParams),
      pool.query<{ input: string | null; cache_read: string | null; cache_write: string | null; output: string | null }>(
        `SELECT SUM((u->>'input')::numeric) AS input, SUM((u->>'cacheRead')::numeric) AS cache_read, SUM((u->>'cacheWrite')::numeric) AS cache_write, SUM((u->>'output')::numeric) AS output FROM (
           SELECT jsonb_array_elements(COALESCE(s.usage_by_model, '[]'::jsonb)) AS u FROM sessions s WHERE ${inRange}
           UNION ALL
           SELECT jsonb_array_elements(COALESCE(a.usage_by_model, '[]'::jsonb)) FROM agents a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id WHERE ${inRange}
         ) x`,
        sessParams,
      ),
      pool.query<{ id: string; name: string | null; owner: string | null; cost: string }>(
        `SELECT s.id, COALESCE(s.name, s.git->>'repo', s.cwd) AS name, o.name AS owner, SUM(u.cost_usd) AS cost ${FROM} GROUP BY s.id, s.name, s.git, s.cwd, o.name ORDER BY 4 DESC LIMIT 5`,
        base.slice(0, q.team ? 4 : 3),
      ),
    ]);
    const failsByTool = new Map(toolFails.rows.map((r) => [r.tool ?? "", r.fails]));
    const heat: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const r of hours.rows) heat[r.dow - 1]![r.hour] = r.n;
    const c = cache.rows[0];
    const promptSide = Number(c?.input ?? 0) + Number(c?.cache_read ?? 0) + Number(c?.cache_write ?? 0);

    // Fill every day in the range, so gaps read as zero rather than vanish.
    const byDay = new Map(daily.rows.map((d) => [d.day, d]));
    const series: { day: string; costUsd: number; tokens: number; sessions: number; anomaly?: boolean }[] = [];
    for (let i = 0; i < days; i++) {
      const d = utcDay(Date.parse(from) + i * 86_400_000);
      const row = byDay.get(d);
      series.push({ day: d, costUsd: Number(row?.cost ?? 0), tokens: Number(row?.tokens ?? 0), sessions: row?.sessions ?? 0 });
    }
    const flagged = anomalies(series);
    for (const d of series) if (flagged.has(d.day)) d.anomaly = true;

    // Forecast for the current calendar month (UTC), from the last seven full days.
    const today = utcDay(Date.now());
    const monthStart = `${today.slice(0, 7)}-01`;
    const mtd = await pool.query<{ cost: string | null }>(
      `SELECT SUM(u.cost_usd) AS cost FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND u.day >= $2::date${q.team ? " AND s.team_id = $4" : ""} AND u.day <= $3::date`,
      q.team ? [p.orgId, monthStart, today, q.team] : [p.orgId, monthStart, today],
    );
    const last7 = await pool.query<{ cost: string | null }>(
      `SELECT SUM(u.cost_usd) AS cost FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND u.day BETWEEN ($2::date - 7) AND ($2::date - 1)${q.team ? " AND s.team_id = $3" : ""}`,
      q.team ? [p.orgId, today, q.team] : [p.orgId, today],
    );
    const now = new Date();
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    const daysLeft = monthEnd.getUTCDate() - now.getUTCDate();
    const runRate = Number(last7.rows[0]?.cost ?? 0) / 7;
    const mtdUsd = Number(mtd.rows[0]?.cost ?? 0);

    const t = totals.rows[0]!;
    const a = asks.rows[0]!;
    return {
      range: { from, to, days, groupBy: q.groupBy },
      totals: {
        costUsd: Number(t.cost ?? 0),
        prevCostUsd: Number(prev.rows[0]?.cost ?? 0),
        tokens: Number(t.tokens ?? 0),
        sessions: t.sessions,
        people: t.people,
        agents: agentStats.rows[0]!.agents,
        failedAgents: agentStats.rows[0]!.failed,
        blowouts: agentStats.rows[0]!.blowouts,
        asks: a.total,
        answeredInTessera: a.answered,
        answeredInSlack: a.slack,
        meanWaitMs: a.mean_ms,
      },
      daily: series,
      groups: groups.rows.map((g) => ({ key: g.key, id: g.id, costUsd: Number(g.cost), prevCostUsd: prevByKey.get(g.key) ?? 0, tokens: Number(g.tokens), sessions: g.sessions, people: g.people })),
      models: models.rows.map((m) => ({ model: m.model, costUsd: Number(m.cost), sessions: m.sessions })),
      forecast: { monthStart, monthEnd: utcDay(monthEnd.getTime()), monthToDateUsd: mtdUsd, dailyRunRateUsd: runRate, projectedMonthUsd: mtdUsd + runRate * daysLeft },
      tools: tools.rows.map((r) => ({ tool: r.tool, calls: Number(r.calls), fails: failsByTool.get(r.tool) ?? 0 })),
      waits: {
        byKind: waits.rows.map((w) => ({ kind: w.kind, count: w.n, p50Ms: w.p50, p90Ms: w.p90, maxMs: w.max, open: w.open })),
        answerers: answerers.rows.map((r) => ({ name: r.name, count: r.n, p50Ms: r.p50 })),
      },
      /** Sessions started per weekday (Monday first) and UTC hour. */
      hours: heat,
      cache: { hitRate: promptSide ? Number(c?.cache_read ?? 0) / promptSide : null, input: Number(c?.input ?? 0), cacheRead: Number(c?.cache_read ?? 0), cacheWrite: Number(c?.cache_write ?? 0), output: Number(c?.output ?? 0) },
      topSessions: topSessions.rows.map((r) => ({ id: r.id, name: r.name, owner: r.owner, costUsd: Number(r.cost) })),
    };
  });

  /**
   * One person or one team over a period: spend against the period before,
   * day by day, the repositories it went on, how long their prompts waited and
   * how fast they answered others', recent sessions, and for a team each
   * member's share. Visible to everyone who can see the wall, as Analytics is.
   */
  app.get("/profile/:kind/:id", async (req, reply) => {
    const p = req.principal!;
    const { kind, id } = z.object({ kind: z.enum(["person", "team"]), id: z.string().uuid() }).parse(req.params);
    const pq = z.object({ days: z.coerce.number().int().min(1).max(366).default(30), from: Range.shape.from, to: Range.shape.to }).parse(req.query);
    const { from, to, days } = range({ groupBy: "team", ...pq });
    await freshen().catch((e) => req.log.warn({ err: e }, "rollup failed"));
    const subject =
      kind === "person"
        ? (await pool.query<{ id: string; name: string; role: string; status: string; team_id: string | null; team_name: string | null }>(
            "SELECT u.id, u.name, u.role, u.status, u.team_id, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.org_id = $1 AND u.id = $2",
            [p.orgId, id],
          )).rows[0]
        : (await pool.query<{ id: string; name: string; cost_center: string | null; members: number }>(
            "SELECT t.id, t.name, t.cost_center, (SELECT COUNT(*)::int FROM users u WHERE u.team_id = t.id AND u.status <> 'disabled') AS members FROM teams t WHERE t.org_id = $1 AND t.id = $2",
            [p.orgId, id],
          )).rows[0];
    if (!subject) return reply.code(404).send({ error: `no such ${kind}` });

    const col = kind === "person" ? "s.owner_id" : "s.team_id";
    const prevFrom = utcDay(Date.parse(from) - days * 86_400_000);
    const prevTo = utcDay(Date.parse(from) - 86_400_000);
    const spend = `FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND ${col} = $2 AND u.day BETWEEN $3::date AND $4::date`;
    const started = `s.org_id = $1 AND ${col} = $2 AND s.started_at >= $3::date AND s.started_at < ($4::date + 1)`;
    const args = [p.orgId, id, from, to];
    const [totals, prev, daily, repos, sessionStats, waits, answered, recent, members] = await Promise.all([
      pool.query<{ cost: string | null; tokens: string | null; sessions: number }>(`SELECT SUM(u.cost_usd) AS cost, SUM(u.tokens) AS tokens, COUNT(DISTINCT u.session_id)::int AS sessions ${spend}`, args),
      pool.query<{ cost: string | null; sessions: number }>(`SELECT SUM(u.cost_usd) AS cost, COUNT(DISTINCT u.session_id)::int AS sessions ${spend}`, [p.orgId, id, prevFrom, prevTo]),
      pool.query<{ day: string; cost: string; sessions: number }>(`SELECT to_char(u.day, 'YYYY-MM-DD') AS day, SUM(u.cost_usd) AS cost, COUNT(DISTINCT u.session_id)::int AS sessions ${spend} GROUP BY u.day`, args),
      pool.query<{ repo: string; cost: string; sessions: number }>(`SELECT COALESCE(s.git->>'repo', 'No repository') AS repo, SUM(u.cost_usd) AS cost, COUNT(DISTINCT u.session_id)::int AS sessions ${spend} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, args),
      pool.query<{ failed: number; blowouts: number }>(
        `SELECT COALESCE(SUM((SELECT COUNT(*) FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.status = 'failed')), 0)::int AS failed, COALESCE(SUM(s.blowouts), 0)::int AS blowouts FROM sessions s WHERE ${started}`,
        args,
      ),
      pool.query<{ n: number; p50: number | null }>(
        `SELECT COUNT(*)::int AS n, (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS p50
           FROM asks a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id
          WHERE a.org_id = $1 AND ${col} = $2 AND a.created_at >= $3::date AND a.created_at < ($4::date + 1)`,
        args,
      ),
      pool.query<{ n: number; p50: number | null }>(
        `SELECT COUNT(*)::int AS n, (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.closed_at - a.created_at))) * 1000)::float AS p50
           FROM asks a JOIN users w ON w.id = a.answered_by
          WHERE a.org_id = $1 AND a.outcome = 'answered' AND ${kind === "person" ? "w.id = $2" : "w.team_id = $2"} AND a.created_at >= $3::date AND a.created_at < ($4::date + 1)`,
        args,
      ),
      pool.query<{ id: string; name: string | null; owner: string | null; owner_id: string | null; status: string; started_at: string; ended_at: string | null; cost: string | null }>(
        `SELECT s.id, COALESCE(s.name, s.git->>'repo', s.cwd) AS name, o.name AS owner, s.owner_id, s.status, s.started_at, COALESCE(s.ended_at, s.dropped_at) AS ended_at,
                (SELECT SUM(x.cost_usd) FROM usage_daily x WHERE x.org_id = s.org_id AND x.session_id = s.id) AS cost
           FROM sessions s LEFT JOIN users o ON o.id = s.owner_id WHERE s.org_id = $1 AND ${col} = $2 ORDER BY s.started_at DESC LIMIT 10`,
        [p.orgId, id],
      ),
      kind === "team"
        ? pool.query<{ id: string; name: string; role: string; cost: string | null; prev: string | null; sessions: number }>(
            `SELECT w.id, w.name, w.role,
                    (SELECT SUM(u.cost_usd) FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND s.owner_id = w.id AND u.day BETWEEN $3::date AND $4::date) AS cost,
                    (SELECT SUM(u.cost_usd) FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id WHERE u.org_id = $1 AND s.owner_id = w.id AND u.day BETWEEN $5::date AND $6::date) AS prev,
                    (SELECT COUNT(*)::int FROM sessions s WHERE s.org_id = $1 AND s.owner_id = w.id AND s.started_at >= $3::date AND s.started_at < ($4::date + 1)) AS sessions
               FROM users w WHERE w.org_id = $1 AND w.team_id = $2 AND w.status <> 'disabled' ORDER BY cost DESC NULLS LAST, w.name`,
            [p.orgId, id, from, to, prevFrom, prevTo],
          )
        : Promise.resolve(null),
    ]);
    const byDay = new Map(daily.rows.map((d) => [d.day, d]));
    const series = Array.from({ length: days }, (_, i) => {
      const d = utcDay(Date.parse(from) + i * 86_400_000);
      return { day: d, costUsd: Number(byDay.get(d)?.cost ?? 0), sessions: byDay.get(d)?.sessions ?? 0 };
    });
    const flagged = anomalies(series);
    const t = totals.rows[0]!;
    const sub = subject as Record<string, unknown>;
    return {
      subject:
        kind === "person"
          ? { kind, id, name: sub.name, role: sub.role, status: sub.status, team: sub.team_id ? { id: sub.team_id, name: sub.team_name } : null }
          : { kind, id, name: sub.name, costCenter: sub.cost_center ?? null, members: sub.members },
      range: { from, to, days },
      totals: {
        costUsd: Number(t.cost ?? 0),
        prevCostUsd: Number(prev.rows[0]?.cost ?? 0),
        sessions: t.sessions,
        prevSessions: prev.rows[0]?.sessions ?? 0,
        tokens: Number(t.tokens ?? 0),
        failedAgents: sessionStats.rows[0]!.failed,
        blowouts: sessionStats.rows[0]!.blowouts,
      },
      daily: series.map((d) => (flagged.has(d.day) ? { ...d, anomaly: true } : d)),
      repos: repos.rows.map((r) => ({ repo: r.repo, costUsd: Number(r.cost), sessions: r.sessions })),
      prompts: { waited: { count: waits.rows[0]!.n, p50Ms: waits.rows[0]!.p50 }, answered: { count: answered.rows[0]!.n, p50Ms: answered.rows[0]!.p50 } },
      recent: recent.rows.map((r) => ({ id: r.id, name: r.name, owner: r.owner, ownerId: r.owner_id, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, costUsd: r.cost === null ? null : Number(r.cost) })),
      members: members ? members.rows.map((m) => ({ id: m.id, name: m.name, role: m.role, costUsd: Number(m.cost ?? 0), prevCostUsd: Number(m.prev ?? 0), sessions: m.sessions })) : null,
    };
  });

  /** Chargeback export: one row per allocation group, or one per session with every allocation column. */
  app.get("/export.csv", async (req, reply: FastifyReply) => {
    const p = admin(req);
    const q = Range.extend({ detail: z.enum(["groups", "sessions"]).default("groups") }).parse(req.query);
    const { from, to } = range(q);
    await freshen().catch(() => {});
    const pattern = await ticketPatternFor(p.orgId);
    const params: unknown[] = [p.orgId, from, to];
    const teamFilter = q.team ? ` AND s.team_id = $${params.push(q.team)}` : "";
    const FROM = `FROM usage_daily u JOIN sessions s ON s.org_id = u.org_id AND s.id = u.session_id
                  LEFT JOIN teams t ON t.id = s.team_id AND t.org_id = s.org_id LEFT JOIN users o ON o.id = s.owner_id
                 WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date${teamFilter}`;
    let rows: unknown[][];
    if (q.detail === "sessions") {
      const ticket = `COALESCE(NULLIF(s.tags->>'ticket', ''), substring(s.git->>'branch' from $${params.push(pattern)}))`;
      const r = await pool.query(
        `SELECT s.id, s.name, s.started_at, COALESCE(s.ended_at, s.dropped_at) AS ended_at, o.name AS person, o.email, t.name AS team, t.cost_center,
                s.git->>'repo' AS repo, s.git->>'branch' AS branch, ${ticket} AS ticket, s.model, s.tags, SUM(u.tokens) AS tokens, SUM(u.cost_usd) AS cost
           ${FROM} GROUP BY s.org_id, s.id, o.name, o.email, t.name, t.cost_center ORDER BY cost DESC`,
        params,
      );
      rows = [["session_id", "name", "started_at", "ended_at", "person", "email", "team", "cost_center", "repository", "branch", "ticket", "model", "tags", "tokens", "cost_usd"]];
      for (const x of r.rows) rows.push([x.id, x.name, new Date(x.started_at).toISOString(), x.ended_at ? new Date(x.ended_at).toISOString() : "", x.person, x.email, x.team, x.cost_center, x.repo, x.branch, x.ticket, x.model, Object.entries(x.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(";"), x.tokens, Number(x.cost).toFixed(4)]);
    } else {
      const key = groupExpr(q.groupBy, params, pattern);
      const r = await pool.query(`SELECT ${key} AS key, COUNT(DISTINCT u.session_id)::int AS sessions, COUNT(DISTINCT s.owner_id)::int AS people, SUM(u.tokens) AS tokens, SUM(u.cost_usd) AS cost ${FROM} GROUP BY 1 ORDER BY 5 DESC`, params);
      rows = [[q.groupBy.replace("tag:", ""), "sessions", "people", "tokens", "cost_usd"]];
      for (const x of r.rows) rows.push([x.key, x.sessions, x.people, x.tokens, Number(x.cost).toFixed(4)]);
    }
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "spend.export", detail: { from, to, detail: q.detail, groupBy: q.groupBy, rows: rows.length - 1 }, ip: req.ip });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="tessera-${q.detail === "sessions" ? "sessions" : q.groupBy.replace("tag:", "tag-")}-${from}-to-${to}.csv"`);
    return toCsv(rows);
  });

  app.get("/settings", async (req) => {
    const p = req.principal!;
    const [pattern, teams] = await Promise.all([ticketPatternFor(p.orgId), pool.query<{ id: string; name: string; cost_center: string | null }>("SELECT id, name, cost_center FROM teams WHERE org_id = $1 ORDER BY name", [p.orgId])]);
    const tags = await pool.query<{ k: string }>(
      "SELECT DISTINCT jsonb_object_keys(tags) AS k FROM sessions WHERE org_id = $1 AND tags <> '{}'::jsonb AND started_at > now() - interval '90 days' LIMIT 50",
      [p.orgId],
    );
    return { ticketPattern: pattern, defaultTicketPattern: DEFAULT_TICKET_PATTERN, teams: teams.rows.map((t) => ({ id: t.id, name: t.name, costCenter: t.cost_center })), tagKeys: tags.rows.map((r) => r.k).filter((k) => k !== "paused").sort(), groups: GROUPS };
  });

  app.put("/settings", async (req, reply) => {
    const p = admin(req);
    const body = z.object({
      ticketPattern: z.string().trim().min(1).max(100).optional(),
      costCenters: z.array(z.object({ teamId: z.string().uuid(), costCenter: z.string().trim().max(60) })).max(500).optional(),
    }).parse(req.body);
    if (body.ticketPattern) {
      try {
        new RegExp(body.ticketPattern);
      } catch {
        return reply.code(400).send({ error: "That ticket pattern is not a valid regular expression." });
      }
      // Postgres must accept it too; this also rejects patterns it cannot compile.
      try {
        await pool.query("SELECT substring('ABC-1' from $1)", [body.ticketPattern]);
      } catch {
        return reply.code(400).send({ error: "That ticket pattern is not supported." });
      }
      await pool.query("UPDATE orgs SET settings = settings || jsonb_build_object('ticketPattern', $2::text) WHERE id = $1", [p.orgId, body.ticketPattern]);
    }
    for (const c of body.costCenters ?? []) await pool.query("UPDATE teams SET cost_center = NULLIF($3, '') WHERE id = $1 AND org_id = $2", [c.teamId, p.orgId, c.costCenter]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "allocation.update", detail: body, ip: req.ip });
    return { ok: true };
  });
}
