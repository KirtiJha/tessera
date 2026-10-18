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

export async function upsertSession(q: Queryable, rec: SessionRecord): Promise<void> {
  await q.query(
    `INSERT INTO sessions (org_id, id, team_id, owner_id, device_id, name, reporter_kind, reporter_version, hostname, machine_id, cwd, model, effort,
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
        control = EXCLUDED.control`,
    [
      rec.orgId, rec.id, rec.teamId, rec.ownerId, rec.deviceId, rec.name, rec.reporterKind, rec.reporterVersion, rec.hostname, rec.machineId,
      rec.cwd, rec.model, rec.effort, rec.status, rec.waitReason, rec.startedAt, rec.endedAt, rec.endReason, rec.lastSeenAt, rec.droppedAt,
      rec.contextUsed, rec.contextWindow, JSON.stringify(rec.tokens), JSON.stringify(rec.usageByModel), rec.ledgerCostUsd, rec.blowouts,
      rec.git ? JSON.stringify(rec.git) : null, JSON.stringify(rec.filesChanged), rec.plan ? JSON.stringify(rec.plan) : null,
      rec.openAsk ? JSON.stringify(rec.openAsk) : null, JSON.stringify(rec.tags), rec.continuedFrom, JSON.stringify(rec.control),
    ],
  );
  for (const a of rec.agents) {
    await q.query(
      `INSERT INTO agents (org_id, session_id, id, parent_id, kind, type, description, model, effort, status, started_at, ended_at, tokens,
          usage_by_model, context, tool_calls, skills, failure, prompt_excerpt, answer_excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (org_id, session_id, id) DO UPDATE SET
          parent_id = EXCLUDED.parent_id, kind = EXCLUDED.kind, type = EXCLUDED.type, description = EXCLUDED.description,
          model = EXCLUDED.model, effort = EXCLUDED.effort, status = EXCLUDED.status, started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at, tokens = EXCLUDED.tokens, usage_by_model = EXCLUDED.usage_by_model, context = EXCLUDED.context,
          tool_calls = EXCLUDED.tool_calls, skills = EXCLUDED.skills, failure = EXCLUDED.failure,
          prompt_excerpt = EXCLUDED.prompt_excerpt, answer_excerpt = EXCLUDED.answer_excerpt`,
      [
        rec.orgId, rec.id, a.id, a.parentId, a.kind, a.type, a.description, a.model, a.effort, a.status, a.startedAt, a.endedAt,
        JSON.stringify(a.tokens), JSON.stringify(a.usageByModel), a.context ? JSON.stringify(a.context) : null, JSON.stringify(a.toolCalls),
        JSON.stringify(a.skills), a.failure ? JSON.stringify(a.failure) : null, a.promptExcerpt, a.answerExcerpt,
      ],
    );
  }
}

/** Insert events idempotently; returns the ids that were new. */
export async function insertEvents(q: Queryable, orgId: string, sessionId: string, events: ActivityEvent[]): Promise<string[]> {
  const fresh: string[] = [];
  for (const e of events) {
    const r = await q.query(
      `INSERT INTO events (org_id, session_id, id, ts, kind, agent_id, text, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, session_id, id) DO NOTHING`,
      [orgId, sessionId, e.id, e.ts, e.kind, e.agentId, e.text, e.data ? JSON.stringify(e.data) : null],
    );
    if (r.rowCount) fresh.push(e.id);
  }
  return fresh;
}

export async function insertSample(
  q: Queryable,
  orgId: string,
  sessionId: string,
  ts: string,
  tokensTotal: number,
  tokensDelta: number,
  costUsd: number | null,
  usage: ModelUsage[],
): Promise<void> {
  await q.query(
    `INSERT INTO samples (org_id, session_id, ts, tokens_total, tokens_delta, cost_usd, usage_by_model)
     VALUES ($1,$2,date_trunc('second', $3::timestamptz),$4,$5,$6,$7) ON CONFLICT (org_id, session_id, ts) DO UPDATE SET
       tokens_total = EXCLUDED.tokens_total, tokens_delta = samples.tokens_delta + EXCLUDED.tokens_delta, cost_usd = EXCLUDED.cost_usd,
       usage_by_model = EXCLUDED.usage_by_model`,
    [orgId, sessionId, ts, tokensTotal, tokensDelta, costUsd, JSON.stringify(usage)],
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

export async function prune(retainSamplesDays: number, retainEventsDays: number, retainSessionsDays: number): Promise<void> {
  await pool.query("DELETE FROM samples WHERE ts < now() - ($1 || ' days')::interval", [String(retainSamplesDays)]);
  await pool.query("DELETE FROM events WHERE ts < now() - ($1 || ' days')::interval", [String(retainEventsDays)]);
  await pool.query("DELETE FROM sessions WHERE COALESCE(ended_at, dropped_at) < now() - ($1 || ' days')::interval", [String(retainSessionsDays)]);
  await pool.query("DELETE FROM user_sessions WHERE expires_at < now()");
  await pool.query("DELETE FROM enrolment_codes WHERE expires_at < now() - interval '1 day'");
}
