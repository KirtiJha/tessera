import type { ActivityEvent, AgentReport, EventView, ModelUsage } from "@tessera/contract";
import { pool, type Queryable } from "../db/pool.js";
import type { SessionRecord } from "./types.js";

interface SessionRow {
  org_id: string;
  id: string;
  team_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  device_id: string | null;
  name: string | null;
  reporter_kind: string;
  reporter_version: string;
  hostname: string | null;
  machine_id: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  status: SessionRecord["status"];
  wait_reason: SessionRecord["waitReason"];
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  last_seen_at: string;
  dropped_at: string | null;
  context_used: number | null;
  context_window: number | null;
  tokens: SessionRecord["tokens"];
  usage_by_model: ModelUsage[];
  ledger_cost_usd: number | null;
  blowouts: number;
  git: SessionRecord["git"];
  files_changed: SessionRecord["filesChanged"];
  plan: SessionRecord["plan"];
  open_ask: SessionRecord["openAsk"];
  tags: Record<string, string>;
  continued_from: string | null;
  control: SessionRecord["control"];
}

interface AgentRow {
  session_id: string;
  id: string;
  parent_id: string | null;
  kind: AgentReport["kind"];
  type: string | null;
  description: string | null;
  model: string | null;
  effort: AgentReport["effort"];
  status: AgentReport["status"];
  started_at: string;
  ended_at: string | null;
  tokens: AgentReport["tokens"];
  usage_by_model: ModelUsage[];
  context: AgentReport["context"];
  tool_calls: Record<string, number>;
  skills: string[];
  failure: AgentReport["failure"];
  prompt_excerpt: string | null;
  answer_excerpt: string | null;
}

const SESSION_SELECT = `SELECT s.*, u.name AS owner_name FROM sessions s LEFT JOIN users u ON u.id = s.owner_id`;

function rowToRecord(r: SessionRow, agents: AgentRow[]): SessionRecord {
  return {
    orgId: r.org_id,
    id: r.id,
    teamId: r.team_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    deviceId: r.device_id,
    name: r.name,
    reporterKind: r.reporter_kind,
    reporterVersion: r.reporter_version,
    hostname: r.hostname,
    machineId: r.machine_id,
    cwd: r.cwd,
    model: r.model,
    effort: r.effort,
    status: r.status,
    waitReason: r.wait_reason,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    lastSeenAt: r.last_seen_at,
    droppedAt: r.dropped_at,
    contextUsed: r.context_used,
    contextWindow: r.context_window,
    tokens: r.tokens,
    usageByModel: r.usage_by_model,
    ledgerCostUsd: r.ledger_cost_usd,
    blowouts: r.blowouts,
    git: r.git,
    filesChanged: r.files_changed,
    plan: r.plan,
    openAsk: r.open_ask,
    tags: r.tags,
    continuedFrom: r.continued_from,
    control: r.control,
    agents: agents.map((a) => ({
      id: a.id,
      parentId: a.parent_id,
      kind: a.kind,
      type: a.type,
      description: a.description,
      model: a.model,
      effort: a.effort,
      status: a.status,
      startedAt: a.started_at,
      endedAt: a.ended_at,
      tokens: a.tokens,
      usageByModel: a.usage_by_model,
      context: a.context,
      toolCalls: a.tool_calls,
      skills: a.skills,
      failure: a.failure,
      promptExcerpt: a.prompt_excerpt,
      answerExcerpt: a.answer_excerpt,
    })),
  };
}

async function agentsFor(q: Queryable, orgId: string, sessionIds: string[]): Promise<Map<string, AgentRow[]>> {
  const out = new Map<string, AgentRow[]>();
  if (sessionIds.length === 0) return out;
  const r = await q.query<AgentRow>("SELECT * FROM agents WHERE org_id = $1 AND session_id = ANY($2) ORDER BY started_at ASC", [orgId, sessionIds]);
  for (const a of r.rows) {
    let list = out.get(a.session_id);
    if (!list) out.set(a.session_id, (list = []));
    list.push(a);
  }
  return out;
}

/** Sessions that should be in the live set at start: not dropped, and either not ended or ended within `lingerMs`. */
export async function loadLiveSessions(lingerMs: number): Promise<SessionRecord[]> {
  const r = await pool.query<SessionRow>(
    `${SESSION_SELECT} WHERE s.dropped_at IS NULL AND (s.ended_at IS NULL OR s.ended_at > now() - ($1 || ' milliseconds')::interval)`,
    [String(lingerMs)],
  );
  const byOrg = new Map<string, string[]>();
  for (const row of r.rows) byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), row.id]);
  const agents = new Map<string, AgentRow[]>();
  for (const [orgId, ids] of byOrg) for (const [sid, list] of await agentsFor(pool, orgId, ids)) agents.set(`${orgId}:${sid}`, list);
  return r.rows.map((row) => rowToRecord(row, agents.get(`${row.org_id}:${row.id}`) ?? []));
}

export async function loadSession(orgId: string, id: string, q: Queryable = pool): Promise<SessionRecord | null> {
  const r = await q.query<SessionRow>(`${SESSION_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  const row = r.rows[0];
  if (!row) return null;
  const agents = await agentsFor(q, orgId, [id]);
  return rowToRecord(row, agents.get(id) ?? []);
}

const SESSION_UPSERT = `INSERT INTO sessions (org_id, id, team_id, owner_id, device_id, name, reporter_kind, reporter_version, hostname, machine_id, cwd, model, effort,
        status, wait_reason, started_at, ended_at, end_reason, last_seen_at, dropped_at, context_used, context_window, tokens, usage_by_model,
        ledger_cost_usd, blowouts, git, files_changed, plan, open_ask, tags, continued_from, control)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
     ON CONFLICT (org_id, id) DO UPDATE SET
        team_id = EXCLUDED.team_id, owner_id = EXCLUDED.owner_id, device_id = EXCLUDED.device_id, name = EXCLUDED.name,
        reporter_kind = EXCLUDED.reporter_kind, reporter_version = EXCLUDED.reporter_version, hostname = EXCLUDED.hostname,
        machine_id = EXCLUDED.machine_id, cwd = EXCLUDED.cwd, model = EXCLUDED.model, effort = EXCLUDED.effort, status = EXCLUDED.status,
        wait_reason = EXCLUDED.wait_reason, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, end_reason = EXCLUDED.end_reason,
        last_seen_at = EXCLUDED.last_seen_at, dropped_at = EXCLUDED.dropped_at, context_used = EXCLUDED.context_used,
        context_window = EXCLUDED.context_window, tokens = EXCLUDED.tokens, usage_by_model = EXCLUDED.usage_by_model,
        ledger_cost_usd = EXCLUDED.ledger_cost_usd, blowouts = EXCLUDED.blowouts, git = EXCLUDED.git, files_changed = EXCLUDED.files_changed,
        plan = EXCLUDED.plan, open_ask = EXCLUDED.open_ask, tags = EXCLUDED.tags, continued_from = EXCLUDED.continued_from,
        control = EXCLUDED.control`;

function sessionParams(rec: SessionRecord): unknown[] {
  return [
    rec.orgId, rec.id, rec.teamId, rec.ownerId, rec.deviceId, rec.name, rec.reporterKind, rec.reporterVersion, rec.hostname, rec.machineId,
    rec.cwd, rec.model, rec.effort, rec.status, rec.waitReason, rec.startedAt, rec.endedAt, rec.endReason, rec.lastSeenAt, rec.droppedAt,
    rec.contextUsed, rec.contextWindow, JSON.stringify(rec.tokens), JSON.stringify(rec.usageByModel), rec.ledgerCostUsd, rec.blowouts,
    rec.git ? JSON.stringify(rec.git) : null, JSON.stringify(rec.filesChanged), rec.plan ? JSON.stringify(rec.plan) : null,
    rec.openAsk ? JSON.stringify(rec.openAsk) : null, JSON.stringify(rec.tags), rec.continuedFrom, JSON.stringify(rec.control),
  ];
}

export async function upsertSession(q: Queryable, rec: SessionRecord): Promise<void> {
  await q.query(SESSION_UPSERT, sessionParams(rec));
}

export interface IngestResult {
  freshEventIds: string[];
  deliveries: { id: string; kind: "answer" | "message" | "command"; askId: string | null; payload: Record<string, unknown> }[];
}

/**
 * Everything one report writes, in a single statement and a single round trip:
 * the session row, the agents that changed, new events, and claiming any
 * deliveries waiting for the session. Postgres runs data-modifying CTEs as one
 * atomic statement, so this is all-or-nothing like a transaction.
 */
export async function ingestOne(q: Queryable, rec: SessionRecord, agents: AgentReport[], events: ActivityEvent[]): Promise<IngestResult> {
  const agentRows = agents.map((a) => ({
    id: a.id, parent_id: a.parentId, kind: a.kind, type: a.type, description: a.description, model: a.model, effort: a.effort,
    status: a.status, started_at: a.startedAt, ended_at: a.endedAt, tokens: a.tokens, usage_by_model: a.usageByModel, context: a.context,
    tool_calls: a.toolCalls, skills: a.skills, failure: a.failure, prompt_excerpt: a.promptExcerpt, answer_excerpt: a.answerExcerpt,
  }));
  const eventRows = events.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, agent_id: e.agentId, text: e.text, data: e.data ?? null }));
  const r = await q.query<{ t: "e" | "d"; id: string; kind: string | null; ask_id: string | null; payload: Record<string, unknown> | null }>(
    `WITH s AS (${SESSION_UPSERT} RETURNING 1),
     a AS (
       INSERT INTO agents (org_id, session_id, id, parent_id, kind, type, description, model, effort, status, started_at, ended_at, tokens,
           usage_by_model, context, tool_calls, skills, failure, prompt_excerpt, answer_excerpt)
       SELECT $1, $2, x.id, x.parent_id, x.kind, x.type, x.description, x.model, x.effort, x.status, x.started_at, x.ended_at, x.tokens,
              COALESCE(x.usage_by_model, '[]'::jsonb), x.context, COALESCE(x.tool_calls, '{}'::jsonb), COALESCE(x.skills, '[]'::jsonb), x.failure,
              x.prompt_excerpt, x.answer_excerpt
         FROM jsonb_to_recordset($34::jsonb) AS x(id text, parent_id text, kind text, type text, description text, model text, effort text,
              status text, started_at timestamptz, ended_at timestamptz, tokens jsonb, usage_by_model jsonb, context jsonb, tool_calls jsonb,
              skills jsonb, failure jsonb, prompt_excerpt text, answer_excerpt text)
       ON CONFLICT (org_id, session_id, id) DO UPDATE SET
          parent_id = EXCLUDED.parent_id, kind = EXCLUDED.kind, type = EXCLUDED.type, description = EXCLUDED.description,
          model = EXCLUDED.model, effort = EXCLUDED.effort, status = EXCLUDED.status, started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at, tokens = EXCLUDED.tokens, usage_by_model = EXCLUDED.usage_by_model, context = EXCLUDED.context,
          tool_calls = EXCLUDED.tool_calls, skills = EXCLUDED.skills, failure = EXCLUDED.failure,
          prompt_excerpt = EXCLUDED.prompt_excerpt, answer_excerpt = EXCLUDED.answer_excerpt
       RETURNING 1),
     e AS (
       INSERT INTO events (org_id, session_id, id, ts, kind, agent_id, text, data)
       SELECT $1, $2, x.id, x.ts, x.kind, x.agent_id, x.text, x.data
         FROM jsonb_to_recordset($35::jsonb) AS x(id text, ts timestamptz, kind text, agent_id text, text text, data jsonb)
       ON CONFLICT (org_id, session_id, id) DO NOTHING RETURNING id),
     d AS (
       UPDATE deliveries SET delivered_at = now() WHERE id IN (
         SELECT id FROM deliveries WHERE org_id = $1 AND session_id = $2 AND delivered_at IS NULL ORDER BY created_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, ask_id, payload, created_at)
     SELECT 'e' AS t, e.id, NULL::text AS kind, NULL::text AS ask_id, NULL::jsonb AS payload, NULL::timestamptz AS at FROM e
     UNION ALL
     SELECT 'd', d.id::text, d.kind, d.ask_id, d.payload, d.created_at FROM d
     ORDER BY at NULLS FIRST`,
    [...sessionParams(rec), JSON.stringify(agentRows), JSON.stringify(eventRows)],
  );
  return {
    freshEventIds: r.rows.filter((x) => x.t === "e").map((x) => x.id),
    deliveries: r.rows.filter((x) => x.t === "d").map((x) => ({ id: x.id, kind: x.kind as "answer" | "message" | "command", askId: x.ask_id, payload: x.payload ?? {} })),
  };
}

export interface SampleRow {
  orgId: string;
  sessionId: string;
  /** Start of the minute this bucket covers. */
  minute: string;
  tokensTotal: number;
  tokensDelta: number;
  costUsd: number | null;
  usage: ModelUsage[];
}

/**
 * Write per-minute sample buckets in one statement. Deltas add up when a
 * bucket is flushed more than once; totals, cost and usage take the latest.
 * Rows for sessions that no longer exist are skipped rather than failing the batch.
 */
export async function flushSamples(q: Queryable, rows: SampleRow[]): Promise<void> {
  if (!rows.length) return;
  const data = rows.map((r) => ({ org_id: r.orgId, session_id: r.sessionId, ts: r.minute, tokens_total: r.tokensTotal, tokens_delta: r.tokensDelta, cost_usd: r.costUsd, usage_by_model: r.usage }));
  await q.query(
    `INSERT INTO samples (org_id, session_id, ts, tokens_total, tokens_delta, cost_usd, usage_by_model)
     SELECT x.org_id, x.session_id, x.ts, x.tokens_total, x.tokens_delta, x.cost_usd, x.usage_by_model
       FROM jsonb_to_recordset($1::jsonb) AS x(org_id uuid, session_id text, ts timestamptz, tokens_total bigint, tokens_delta bigint, cost_usd numeric, usage_by_model jsonb)
       JOIN sessions s ON s.org_id = x.org_id AND s.id = x.session_id
     ON CONFLICT (org_id, session_id, ts) DO UPDATE SET
       tokens_total = EXCLUDED.tokens_total, tokens_delta = samples.tokens_delta + EXCLUDED.tokens_delta,
       cost_usd = EXCLUDED.cost_usd, usage_by_model = EXCLUDED.usage_by_model`,
    [JSON.stringify(data)],
  );
}

export async function recentEvents(orgId: string, limit: number, sessionId?: string): Promise<EventView[]> {
  const r = sessionId
    ? await pool.query("SELECT * FROM events WHERE org_id = $1 AND session_id = $2 ORDER BY ts DESC LIMIT $3", [orgId, sessionId, limit])
    : await pool.query("SELECT * FROM events WHERE org_id = $1 ORDER BY ts DESC LIMIT $2", [orgId, limit]);
  return r.rows.map((e) => ({ id: e.id, sessionId: e.session_id, ts: e.ts, kind: e.kind, agentId: e.agent_id, text: e.text }));
}

export async function markDropped(orgId: string, id: string, at: string): Promise<void> {
  await pool.query("UPDATE sessions SET dropped_at = $3 WHERE org_id = $1 AND id = $2 AND dropped_at IS NULL", [orgId, id, at]);
}

export async function setControl(orgId: string, id: string, control: SessionRecord["control"]): Promise<void> {
  await pool.query("UPDATE sessions SET control = $3 WHERE org_id = $1 AND id = $2", [orgId, id, JSON.stringify(control)]);
}

/**
 * Delete data past its retention. Each organisation may set its own windows
 * (orgs.settings.data); an organisation under legal hold is skipped entirely.
 * The audit log is never pruned, so its hash chain always verifies from the start.
 */
export async function prune(retainSamplesDays: number, retainEventsDays: number, retainSessionsDays: number): Promise<void> {
  const held = "COALESCE(o.settings->'data'->'legalHold', 'null'::jsonb) <> 'null'::jsonb";
  const days = (key: string, def: number) => `make_interval(days => COALESCE((o.settings->'data'->>'${key}')::int, ${Math.trunc(def)}))`;
  await pool.query(`DELETE FROM samples x USING orgs o WHERE x.org_id = o.id AND NOT ${held} AND x.ts < now() - ${days("retainSamplesDays", retainSamplesDays)}`);
  await pool.query(`DELETE FROM events x USING orgs o WHERE x.org_id = o.id AND NOT ${held} AND x.ts < now() - ${days("retainEventsDays", retainEventsDays)}`);
  await pool.query(`DELETE FROM policy_decisions x USING orgs o WHERE x.org_id = o.id AND NOT ${held} AND x.created_at < now() - ${days("retainEventsDays", retainEventsDays)}`);
  await pool.query(`DELETE FROM sessions x USING orgs o WHERE x.org_id = o.id AND NOT ${held} AND COALESCE(x.ended_at, x.dropped_at) < now() - ${days("retainSessionsDays", retainSessionsDays)}`);
  await pool.query("DELETE FROM user_sessions WHERE expires_at < now()");
  await pool.query("DELETE FROM enrolment_codes WHERE expires_at < now() - interval '1 day'");
}
