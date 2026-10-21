import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { atLeast, canActOn, canManageOrg, type Principal, type Role } from "../auth/rbac.js";
import type { SessionRecord } from "../fleet/types.js";
import { answerAsk } from "../fleet/actions.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { pool } from "../db/pool.js";
import type { Fleet } from "../fleet/fleet.js";
import { priceTableFor } from "../fleet/pricing.js";
import { deriveSession } from "../fleet/derive.js";
import { dataSettingsFor } from "../fleet/datasettings.js";
import { diffView, pendingRequest, requestDiff } from "../fleet/diffs.js";
import { ExplainError, explainFailure } from "../fleet/explain.js";
import { randomUUID } from "node:crypto";
import * as store from "../fleet/store.js";
import { openStream, type StreamHub } from "../fleet/stream.js";
import { config } from "../config.js";

/** Routes the console calls. Every one needs a signed-in user. */
export async function fleetRoutes(app: FastifyInstance, opts: { fleet: Fleet; hub: StreamHub }): Promise<void> {
  const { fleet, hub } = opts;

  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  app.get("/state", async (req) => fleet.snapshot(req.principal!.orgId));

  app.get("/stream", async (req, reply) => {
    const p = req.principal!;
    const client = openStream(reply, req.headers["accept-encoding"]);
    client.write(": connected\n\n");
    if (!hub.add(p.orgId, client, (cb) => reply.raw.on("close", cb))) {
      client.write(`event: error\ndata: ${JSON.stringify({ error: "too many clients" })}\n\n`);
      client.close();
      return reply;
    }
    hub.send(client, { type: "snapshot", data: await fleet.snapshot(p.orgId) });
    const ping = setInterval(() => {
      try {
        client.write(": ping\n\n");
      } catch {
        clearInterval(ping);
      }
    }, 15_000);
    reply.raw.on("close", () => clearInterval(ping));
    return reply;
  });

  app.get("/sessions/:id", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const rec = fleet.get(p.orgId, id) ?? (await store.loadSession(p.orgId, id));
    if (!rec) return reply.code(404).send({ error: "no such session" });
    const view = deriveSession(rec, await priceTableFor(p.orgId), Date.now(), config.staleAfterMs);
    const [events, series, asks] = await Promise.all([
      store.recentEvents(p.orgId, 200, id),
      pool.query<{ ts: string; tokens_delta: number; cost_usd: number | null }>(
        "SELECT ts, tokens_delta, cost_usd FROM samples WHERE org_id = $1 AND session_id = $2 AND ts > now() - interval '2 hours' ORDER BY ts ASC",
        [p.orgId, id],
      ),
      pool.query(
        `SELECT a.id, a.kind, a.tool, a.prompt, a.options, a.created_at, a.closed_at, a.outcome, a.answer, u.name AS answered_by
           FROM asks a LEFT JOIN users u ON u.id = a.answered_by WHERE a.org_id = $1 AND a.session_id = $2 ORDER BY a.created_at DESC LIMIT 50`,
        [p.orgId, id],
      ),
    ]);
    return {
      session: view,
      live: fleet.get(p.orgId, id) !== undefined,
      canAct: canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id }),
      // Explaining a failure sends it to the Claude API: only where the organisation chose that and the server has a key.
      canExplain: await explainAllowed(p, rec),
      events,
      series: series.rows.map((r) => ({ ts: r.ts, tokens: r.tokens_delta, cost: r.cost_usd })),
      asks: asks.rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        tool: a.tool,
        prompt: a.prompt,
        options: a.options,
        createdAt: a.created_at,
        closedAt: a.closed_at,
        outcome: a.outcome,
        answer: a.answer,
        answeredBy: a.answered_by,
      })),
    };
  });

  app.get("/history", async (req) => {
    const p = req.principal!;
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(10).max(100).default(25),
        owner: z.string().uuid().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        search: z.string().max(100).optional(),
        sort: z.enum(["started", "name", "owner", "duration", "tokens"]).default("started"),
        dir: z.enum(["asc", "desc"]).default("desc"),
      })
      .parse(req.query);
    // Sort keys map to fixed expressions; nothing from the query reaches the SQL text.
    const ORDER: Record<typeof q.sort, string> = {
      started: "s.started_at",
      name: "LOWER(COALESCE(s.name, s.git->>'repo', s.cwd, s.id))",
      owner: "LOWER(u.name)",
      duration: "(COALESCE(s.ended_at, s.dropped_at) - s.started_at)",
      tokens: "(COALESCE((s.tokens->>'input')::bigint, 0) + COALESCE((s.tokens->>'output')::bigint, 0) + COALESCE((s.tokens->>'cacheRead')::bigint, 0) + COALESCE((s.tokens->>'cacheWrite')::bigint, 0))",
    };
    const orderBy = `${ORDER[q.sort]} ${q.dir === "asc" ? "ASC NULLS FIRST" : "DESC NULLS LAST"}, s.id`;
    const where: string[] = ["s.org_id = $1", "(s.ended_at IS NOT NULL OR s.dropped_at IS NOT NULL)"];
    const params: unknown[] = [p.orgId];
    if (q.owner) {
      params.push(q.owner);
      where.push(`s.owner_id = $${params.length}`);
    }
    if (q.from) {
      params.push(q.from);
      where.push(`s.started_at >= $${params.length}`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`s.started_at < $${params.length}`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(s.name ILIKE $${params.length} OR s.cwd ILIKE $${params.length} OR s.git->>'repo' ILIKE $${params.length} OR s.git->>'branch' ILIKE $${params.length})`);
    }
    const w = where.join(" AND ");
    const total = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sessions s WHERE ${w}`, params);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await pool.query(
      `SELECT s.id, s.name, s.cwd, s.model, s.status, s.started_at, s.ended_at, s.end_reason, s.dropped_at, s.tokens, s.usage_by_model, s.git,
              s.blowouts, u.name AS owner_name, s.owner_id, s.hostname,
              (SELECT COUNT(*)::int FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id) AS agent_count,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('usageByModel', a.usage_by_model)), '[]'::jsonb) FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id) AS agent_usage,
              (SELECT COUNT(*)::int FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.status = 'failed') AS failed_agents
         FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
        WHERE ${w} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const table = await priceTableFor(p.orgId);
    const { priceFor, totalUsage } = await import("../fleet/pricing.js");
    return {
      total: total.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      sessions: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        cwd: r.cwd,
        model: r.model,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at ?? r.dropped_at,
        endReason: r.end_reason ?? (r.dropped_at ? "dropped" : null),
        tokens: r.tokens,
        costUsd: priceFor(totalUsage(r.usage_by_model, r.agent_usage), table).usd,
        repo: r.git?.repo ?? null,
        branch: r.git?.branch ?? null,
        blowouts: r.blowouts,
        ownerName: r.owner_name,
        ownerId: r.owner_id,
        hostname: r.hostname,
        agentCount: r.agent_count,
        failedAgents: r.failed_agents,
      })),
    };
  });

  app.get("/events", async (req) => {
    const p = req.principal!;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(150) }).parse(req.query);
    return { events: await store.recentEvents(p.orgId, q.limit) };
  });

  // ---- acting on a session ---------------------------------------------

  async function actable(req: Parameters<typeof requireUser>[0], id: string) {
    const p = req.principal!;
    const rec = fleet.get(p.orgId, id);
    if (!rec) throw Object.assign(new Error("session is not live"), { statusCode: 404 });
    if (!canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id })) throw Object.assign(new Error("you cannot act on this session"), { statusCode: 403 });
    return { p, rec };
  }

  /**
   * What an approver wants beside the prompt itself: the plan step under way,
   * the files touched so far, the latest failures, and how this kind of call
   * has been decided before (same tool and program, this owner's sessions,
   * last 30 days). The history is what turns a repeated approval into a rule.
   */
  app.get("/sessions/:id/decision", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const rec = fleet.get(p.orgId, id) ?? (await store.loadSession(p.orgId, id));
    if (!rec) return reply.code(404).send({ error: "no such session" });
    const ask = rec.openAsk;
    const tool = ask?.tool ?? null;
    const command = ask?.detail?.command ?? (ask && tool && ask.prompt.startsWith(`${tool}(`) ? ask.prompt.slice(tool.length + 1, -1) : null);
    const program = command ? (command.trim().split(/\s+/)[0] ?? "").slice(0, 60) : null;
    const step = rec.plan?.steps.find((x) => x.status === "in_progress") ?? null;
    const failures = (rec.activity ?? []).filter((a) => a.status === "failed").slice(-3).reverse();
    let history: { allowed: number; denied: number; lastAt: string | null; lastBy: string | null; byMe: number } | null = null;
    if (tool && ask?.kind === "permission") {
      const patterns = program ? [`${tool}(${program}%`, `${program}%`] : [`${tool}(%`, `${tool}%`];
      const r = await pool.query<{ decision: string; n: number; last_at: string; last_by: string | null; by_me: number }>(
        `SELECT a.answer->>'decision' AS decision, COUNT(*)::int AS n, MAX(a.closed_at) AS last_at,
                (ARRAY_AGG(u.name ORDER BY a.closed_at DESC))[1] AS last_by,
                COUNT(*) FILTER (WHERE a.answered_by = $5)::int AS by_me
           FROM asks a JOIN sessions s ON s.org_id = a.org_id AND s.id = a.session_id LEFT JOIN users u ON u.id = a.answered_by
          WHERE a.org_id = $1 AND a.kind = 'permission' AND a.outcome = 'answered' AND a.closed_at > now() - interval '30 days'
            AND a.tool = $2 AND (a.prompt LIKE $3 OR a.prompt LIKE $4) AND ($6::uuid IS NULL OR s.owner_id = $6)
          GROUP BY 1`,
        [p.orgId, tool, patterns[0], patterns[1], p.userId, rec.ownerId],
      );
      const allowed = r.rows.find((x) => x.decision === "allow");
      const denied = r.rows.find((x) => x.decision === "deny");
      const latest = [...r.rows].sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))[0];
      history = { allowed: allowed?.n ?? 0, denied: denied?.n ?? 0, lastAt: latest?.last_at ?? null, lastBy: latest?.last_by ?? null, byMe: r.rows.reduce((n, x) => n + x.by_me, 0) };
    }
    return {
      step: step ? { title: step.title, index: rec.plan!.steps.indexOf(step) + 1, of: rec.plan!.steps.length } : null,
      files: [...rec.filesChanged].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 3),
      filesTotal: rec.filesChanged.length,
      failures: failures.map((f) => ({ tool: f.tool, summary: f.summary, error: f.error, ts: f.ts })),
      program,
      history,
    };
  });

  app.post("/sessions/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        askId: z.string().max(128),
        decision: z.enum(["allow", "deny", "approve", "reject", "answer"]),
        text: z.string().max(4000).optional(),
        option: z.string().max(300).optional(),
        /** Answers to several questions at once, by question text. */
        answers: z.record(z.string().max(1000), z.string().max(1000)).optional(),
        /** "session" also tells the runtime to stop asking about this pattern until the session ends. */
        scope: z.enum(["once", "session"]).default("once"),
        rule: z.object({ tool: z.string().trim().min(1).max(120), content: z.string().trim().max(300).nullable().default(null) }).optional(),
      })
      .parse(req.body);
    const r = await answerAsk(fleet, req.principal!, id, body, "console", { ip: req.ip, log: req.log });
    return { ok: true, deliveryId: r.deliveryId };
  });

  /** Can this person ask for a failure in this session to be explained? */
  async function explainAllowed(p: Principal, rec: SessionRecord): Promise<boolean> {
    if (!config.anthropicApiKey || !canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id })) return false;
    const d = await dataSettingsFor(rec.orgId);
    return d.explainFailures && d.excerpts;
  }

  /**
   * A short explanation of a failed tool call or a failed agent, by Claude,
   * from the redacted text the reporter sent. Opt-in per organisation.
   */
  app.post("/sessions/:id/explain", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const body = z.object({ kind: z.enum(["agent", "action"]), id: z.string().min(1).max(200) }).parse(req.body);
    const rec = fleet.get(p.orgId, id) ?? (await store.loadSession(p.orgId, id));
    if (!rec) return reply.code(404).send({ error: "no such session" });
    if (!canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id })) return reply.code(403).send({ error: "Only the session's owner, an approver on their team or an admin can ask for an explanation." });
    const d = await dataSettingsFor(p.orgId);
    if (!d.explainFailures || !d.excerpts) return reply.code(403).send({ error: "Explaining failures is turned off for your organisation. An owner can turn it on under Data and compliance." });
    try {
      const e = await explainFailure(rec, body, d.dlp);
      if (!e.cached) await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.explain", targetType: "session", targetId: id, detail: { target: body.kind, model: e.model }, ip: req.ip });
      return e;
    } catch (err) {
      if (err instanceof ExplainError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Ask a live session's machine for its uncommitted diff. The reporter sends
   * it redacted and capped; the server keeps it in memory for 15 minutes.
   * Organisations that keep metadata only (excerpts off) get none. `dir` asks
   * about another repository the session worked in; only one it reported.
   */
  app.post("/sessions/:id/diff", async (req) => {
    const { id } = req.params as { id: string };
    const { p, rec } = await actable(req, id);
    const { dir = null } = z.object({ dir: z.string().max(400).nullable().optional() }).parse(req.body ?? {});
    const other = dir ? (rec.workedIn ?? []).find((w) => w.dir === dir && !w.current) : null;
    if (dir && !(rec.workedIn ?? []).some((w) => w.dir === dir)) throw Object.assign(new Error("The session has not worked in that folder."), { statusCode: 400 });
    if (!(await dataSettingsFor(p.orgId)).excerpts) throw Object.assign(new Error("Your organisation keeps metadata only (Data and compliance), so diffs are not collected."), { statusCode: 403 });
    // The repository it works in now is asked about without a folder, as reporters before this expect.
    const at = other ? other.dir : null;
    const existing = pendingRequest(p.orgId, id, at);
    if (existing) return { ok: true, requestId: existing };
    const requestId = randomUUID();
    requestDiff(p.orgId, id, requestId, p.name, at);
    await fleet.queueDelivery(p.orgId, id, "command", null, { op: "diff", requestId, by: p.name, ...(at ? { dir: at } : {}) }, p.userId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.diff", targetType: "session", targetId: id, detail: { requestId, ...(at ? { dir: at } : {}) }, ip: req.ip });
    return { ok: true, requestId };
  });

  app.get("/sessions/:id/diff", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const rec = fleet.get(p.orgId, id) ?? (await store.loadSession(p.orgId, id));
    if (!rec) return reply.code(404).send({ error: "no such session" });
    if (!canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId, assigneeId: rec.control.assignee?.id })) return reply.code(403).send({ error: "you cannot see this session's diff" });
    return diffView(p.orgId, id);
  });

  app.post("/sessions/:id/message", async (req) => {
    const { id } = req.params as { id: string };
    const { p } = await actable(req, id);
    const body = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const deliveryId = await fleet.queueDelivery(p.orgId, id, "message", null, { text: body.text, by: p.name }, p.userId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.message", targetType: "session", targetId: id, detail: { deliveryId, chars: body.text.length }, ip: req.ip });
    return { ok: true, deliveryId };
  });

  app.post("/sessions/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    const { p } = await actable(req, id);
    const body = z.object({ paused: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
    await fleet.setPaused(p.orgId, id, body.paused, body.reason ?? null, p.name);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: body.paused ? "session.pause" : "session.resume", targetType: "session", targetId: id, detail: { reason: body.reason ?? null }, ip: req.ip });
    return { ok: true };
  });

  app.post("/sessions/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    const { p, rec } = await actable(req, id);
    if (rec.status === "ended") throw Object.assign(new Error("The session has ended."), { statusCode: 409 });
    const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    await fleet.requestStop(p.orgId, id, p.name, body.reason || null);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.stop", targetType: "session", targetId: id, detail: { reason: body.reason ?? null }, ip: req.ip });
    return { ok: true };
  });

  app.post("/sessions/:id/assign", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { p } = await actable(req, id);
    const body = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
    let assignee: { id: string; name: string } | null = null;
    if (body.userId) {
      const u = await pool.query<{ id: string; name: string; role: Role }>("SELECT id, name, role FROM users WHERE id = $1 AND org_id = $2 AND status = 'active'", [body.userId, p.orgId]);
      const row = u.rows[0];
      if (!row) return reply.code(404).send({ error: "No such person in your organisation." });
      if (!atLeast(row.role, "operator")) return reply.code(400).send({ error: `${row.name} is a viewer and cannot act on sessions.` });
      assignee = { id: row.id, name: row.name };
    }
    await fleet.assign(p.orgId, id, assignee, p.name);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: assignee ? "session.assign" : "session.unassign", targetType: "session", targetId: id, detail: { to: assignee?.name ?? null, toId: assignee?.id ?? null }, ip: req.ip });
    return { ok: true };
  });

  /** People a session can be handed to: active members who can act on sessions. */
  app.get("/people", async (req) => {
    const p = req.principal!;
    const r = await pool.query<{ id: string; name: string; role: Role; team_name: string | null }>(
      `SELECT u.id, u.name, u.role, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id AND t.org_id = u.org_id
        WHERE u.org_id = $1 AND u.status = 'active' AND u.role <> 'viewer' ORDER BY u.name`,
      [p.orgId],
    );
    return { people: r.rows.map((u) => ({ id: u.id, name: u.name, role: u.role, team: u.team_name })) };
  });

  /** Everything needed to replay a session: its events, prompts, cost over time, agents and policy decisions. */
  app.get("/sessions/:id/timeline", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const rec = fleet.get(p.orgId, id) ?? (await store.loadSession(p.orgId, id));
    if (!rec) return reply.code(404).send({ error: "no such session" });
    const [events, asks, samples, decisions] = await Promise.all([
      pool.query<{ id: string; ts: string; kind: string; agent_id: string | null; text: string }>(
        "SELECT id, ts, kind, agent_id, text FROM events WHERE org_id = $1 AND session_id = $2 ORDER BY ts ASC, id ASC LIMIT 5000",
        [p.orgId, id],
      ),
      pool.query<{ id: string; kind: string; tool: string | null; prompt: string; created_at: string; closed_at: string | null; outcome: string | null; answer: Record<string, unknown> | null; answered_by: string | null }>(
        `SELECT a.id, a.kind, a.tool, a.prompt, a.created_at, a.closed_at, a.outcome, a.answer, u.name AS answered_by
           FROM asks a LEFT JOIN users u ON u.id = a.answered_by WHERE a.org_id = $1 AND a.session_id = $2 ORDER BY a.created_at ASC LIMIT 500`,
        [p.orgId, id],
      ),
      pool.query<{ ts: string; tokens_total: string; tokens_delta: number; cost_usd: number | null; context_used: number | null; context_window: number | null }>(
        "SELECT ts, tokens_total, tokens_delta, cost_usd, context_used, context_window FROM samples WHERE org_id = $1 AND session_id = $2 ORDER BY ts ASC LIMIT 10000",
        [p.orgId, id],
      ),
      pool.query<{ created_at: string; tool: string; summary: string | null; rule_name: string; effect: string; enforced: boolean }>(
        "SELECT created_at, tool, summary, rule_name, effect, enforced FROM policy_decisions WHERE org_id = $1 AND session_id = $2 ORDER BY created_at ASC LIMIT 1000",
        [p.orgId, id],
      ),
    ]);
    return {
      id: rec.id,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt ?? rec.droppedAt,
      lastSeenAt: rec.lastSeenAt,
      events: events.rows.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, agentId: e.agent_id, text: e.text })),
      asks: asks.rows.map((a) => ({ id: a.id, kind: a.kind, tool: a.tool, prompt: a.prompt, createdAt: a.created_at, closedAt: a.closed_at, outcome: a.outcome, decision: (a.answer?.decision as string | undefined) ?? null, answeredBy: a.answered_by, via: (a.answer?.via as string | undefined) ?? null })),
      samples: samples.rows.map((s) => ({ ts: s.ts, tokens: Number(s.tokens_total), delta: Number(s.tokens_delta), costUsd: s.cost_usd === null ? null : Number(s.cost_usd), contextUsed: s.context_used, contextWindow: s.context_window })),
      agents: rec.agents.map((a) => ({ id: a.id, parentId: a.parentId, type: a.type, kind: a.kind, status: a.status, startedAt: a.startedAt, endedAt: a.endedAt })),
      decisions: decisions.rows.map((d) => ({ ts: d.created_at, tool: d.tool, summary: d.summary, rule: d.rule_name, effect: d.effect, enforced: d.enforced })),
    };
  });

  app.post("/sessions/:id/drop", async (req) => {
    const { id } = req.params as { id: string };
    const { p } = await actable(req, id);
    await fleet.drop(p.orgId, id);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.drop", targetType: "session", targetId: id, ip: req.ip });
    return { ok: true };
  });

  /**
   * Admins remove ended or dropped sessions from history, with their agents,
   * events, samples, prompts and policy decisions. A session that is still
   * live is kept and named in `skipped`: its next report would recreate it,
   * so it has to be dropped from the wall first.
   */
  app.post("/sessions/delete", async (req) => {
    const p = req.principal!;
    if (!canManageOrg(p)) throw Object.assign(new Error("Deleting sessions from history needs the admin role."), { statusCode: 403 });
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(500) }).parse(req.body);
    // A session that has ended but is still lingering on the wall is let go first; one still running is kept.
    const skipped: string[] = [];
    const candidates: string[] = [];
    for (const id of ids) {
      const rec = fleet.get(p.orgId, id);
      if (rec && rec.status !== "ended") skipped.push(id);
      else {
        if (rec) await fleet.drop(p.orgId, id);
        candidates.push(id);
      }
    }
    let deleted = 0;
    if (candidates.length) {
      const r = await pool.query<{ id: string }>("DELETE FROM sessions WHERE org_id = $1 AND id = ANY($2) AND (ended_at IS NOT NULL OR dropped_at IS NOT NULL) RETURNING id", [p.orgId, candidates]);
      deleted = r.rowCount ?? 0;
      if (deleted) {
        const gone = r.rows.map((x) => x.id);
        await pool.query("DELETE FROM policy_decisions WHERE org_id = $1 AND session_id = ANY($2)", [p.orgId, gone]);
        await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.delete", targetType: "session", targetId: gone.length === 1 ? gone[0] : undefined, detail: { count: gone.length, ids: gone.slice(0, 50) }, ip: req.ip });
      }
    }
    return { deleted, skipped };
  });
}
