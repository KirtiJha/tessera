import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { canActOn } from "../auth/rbac.js";
import { answerAsk } from "../fleet/actions.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { pool } from "../db/pool.js";
import type { Fleet } from "../fleet/fleet.js";
import { priceTableFor } from "../fleet/pricing.js";
import { deriveSession } from "../fleet/derive.js";
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
      canAct: canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId }),
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
      })
      .parse(req.query);
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
              (SELECT COUNT(*)::int FROM agents a WHERE a.org_id = s.org_id AND a.session_id = s.id AND a.status = 'failed') AS failed_agents
         FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
        WHERE ${w} ORDER BY s.started_at DESC, s.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const table = await priceTableFor(p.orgId);
    const { priceFor } = await import("../fleet/pricing.js");
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
        costUsd: priceFor(r.usage_by_model, table).usd,
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
    if (!canActOn(p, { ownerId: rec.ownerId, teamId: rec.teamId })) throw Object.assign(new Error("you cannot act on this session"), { statusCode: 403 });
    return { p, rec };
  }

  app.post("/sessions/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        askId: z.string().max(128),
        decision: z.enum(["allow", "deny", "approve", "reject", "answer"]),
        text: z.string().max(4000).optional(),
        option: z.string().max(300).optional(),
      })
      .parse(req.body);
    const r = await answerAsk(fleet, req.principal!, id, body, "console", { ip: req.ip, log: req.log });
    return { ok: true, deliveryId: r.deliveryId };
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

  app.post("/sessions/:id/drop", async (req) => {
    const { id } = req.params as { id: string };
    const { p } = await actable(req, id);
    await fleet.drop(p.orgId, id);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "session.drop", targetType: "session", targetId: id, ip: req.ip });
    return { ok: true };
  });
}
