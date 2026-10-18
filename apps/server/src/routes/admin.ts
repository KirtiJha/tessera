import { BUILTIN_PRICES, PRICES_AS_OF } from "@tessera/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, verifyChain } from "../audit.js";
import { encrypt, newToken, sha256 } from "../auth/crypto.js";
import { forgetDevice, issueDevice } from "../auth/devices.js";
import { atLeast, canManageOrg, type Role } from "../auth/rbac.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { budgetStatuses, invalidateBudgets } from "../fleet/budgets.js";
import { invalidatePrices } from "../fleet/pricing.js";
import { invalidateChannels, notify } from "../notify/notifier.js";

function admin(req: FastifyRequest) {
  const p = req.principal!;
  if (!canManageOrg(p)) throw Object.assign(new Error("admin role required"), { statusCode: 403 });
  return p;
}

const RoleSchema = z.enum(["owner", "admin", "approver", "operator", "viewer"]);

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  // ---- overview (any signed-in user) --------------------------------------
  app.get("/overview", async (req) => {
    const p = req.principal!;
    const [users, devices, teams, budgets] = await Promise.all([
      pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE org_id = $1 AND status <> 'disabled'", [p.orgId]),
      pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM devices WHERE org_id = $1 AND revoked_at IS NULL", [p.orgId]),
      pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM teams WHERE org_id = $1", [p.orgId]),
      budgetStatuses(p.orgId),
    ]);
    return { users: users.rows[0]?.n ?? 0, devices: devices.rows[0]?.n ?? 0, teams: teams.rows[0]?.n ?? 0, budgets };
  });

  // ---- people ---------------------------------------------------------------
  app.get("/users", async (req) => {
    const p = req.principal!;
    const r = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.team_id, t.name AS team_name, u.created_at, u.last_login_at,
              (SELECT COUNT(*)::int FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
         FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.org_id = $1 ORDER BY u.created_at ASC`,
      [p.orgId],
    );
    return { users: r.rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, teamId: u.team_id, teamName: u.team_name, createdAt: u.created_at, lastLoginAt: u.last_login_at, devices: u.devices })) };
  });

  app.post("/users/invite", async (req, reply) => {
    const p = admin(req);
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: z.string().trim().min(1).max(100), role: RoleSchema.default("operator"), teamId: z.string().uuid().nullable().default(null) }).parse(req.body);
    if (body.role === "owner" && p.role !== "owner") return reply.code(403).send({ error: "Only an owner can invite an owner." });
    const token = newToken("tsi");
    try {
      const r = await pool.query<{ id: string }>(
        "INSERT INTO users (org_id, email, name, role, status, team_id, invite_token_hash) VALUES ($1,$2,$3,$4,'invited',$5,$6) RETURNING id",
        [p.orgId, body.email, body.name, body.role, body.teamId, sha256(token)],
      );
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.invite", targetType: "user", targetId: r.rows[0]!.id, detail: { email: body.email, role: body.role }, ip: req.ip });
      return { ok: true, userId: r.rows[0]!.id, inviteUrl: `${config.publicUrl}/invite/${token}` };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "That email already has an account." });
      throw e;
    }
  });

  app.patch("/users/:id", async (req, reply) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    const body = z.object({ role: RoleSchema.optional(), teamId: z.string().uuid().nullable().optional(), status: z.enum(["active", "disabled"]).optional(), name: z.string().trim().min(1).max(100).optional() }).parse(req.body);
    const target = await pool.query<{ role: Role }>("SELECT role FROM users WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    if (!target.rows[0]) return reply.code(404).send({ error: "no such user" });
    if ((target.rows[0].role === "owner" || body.role === "owner") && p.role !== "owner") return reply.code(403).send({ error: "Only an owner can change an owner." });
    if (id === p.userId && (body.status === "disabled" || (body.role && !atLeast(body.role, "admin")))) return reply.code(400).send({ error: "You cannot lock yourself out." });
    const sets: string[] = [];
    const params: unknown[] = [id, p.orgId];
    for (const [k, col] of [["role", "role"], ["teamId", "team_id"], ["status", "status"], ["name", "name"]] as const) {
      if (body[k] !== undefined) {
        params.push(body[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`, params);
    if (body.status === "disabled") await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [id]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.update", targetType: "user", targetId: id, detail: body, ip: req.ip });
    return { ok: true };
  });

  // ---- teams ----------------------------------------------------------------
  app.get("/teams", async (req) => {
    const p = req.principal!;
    const r = await pool.query("SELECT t.id, t.name, t.slug, (SELECT COUNT(*)::int FROM users u WHERE u.team_id = t.id) AS members FROM teams t WHERE t.org_id = $1 ORDER BY t.name", [p.orgId]);
    return { teams: r.rows };
  });

  app.post("/teams", async (req, reply) => {
    const p = admin(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
    try {
      const r = await pool.query<{ id: string }>("INSERT INTO teams (org_id, name, slug) VALUES ($1,$2,$3) RETURNING id", [p.orgId, body.name, slug]);
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "team.create", targetType: "team", targetId: r.rows[0]!.id, detail: { name: body.name }, ip: req.ip });
      return { ok: true, id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "A team with that name exists." });
      throw e;
    }
  });

  app.delete("/teams/:id", async (req) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    await pool.query("DELETE FROM teams WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "team.delete", targetType: "team", targetId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- devices and enrolment -------------------------------------------------
  app.get("/devices", async (req) => {
    const p = req.principal!;
    const all = canManageOrg(p);
    const r = await pool.query(
      `SELECT d.id, d.label, d.hostname, d.machine_id, d.created_at, d.last_seen_at, d.revoked_at, u.name AS user_name, u.id AS user_id
         FROM devices d JOIN users u ON u.id = d.user_id WHERE d.org_id = $1 ${all ? "" : "AND d.user_id = $2"} ORDER BY d.created_at DESC`,
      all ? [p.orgId] : [p.orgId, p.userId],
    );
    return { devices: r.rows.map((d) => ({ id: d.id, label: d.label, hostname: d.hostname, machineId: d.machine_id, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at, userName: d.user_name, userId: d.user_id })) };
  });

  /** Issue a device token directly (shown once). */
  app.post("/devices", async (req) => {
    const p = req.principal!;
    const body = z.object({ label: z.string().trim().min(1).max(120) }).parse(req.body);
    const { id, token } = await issueDevice(p.orgId, p.userId, body.label);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "device.issue", targetType: "device", targetId: id, detail: { label: body.label }, ip: req.ip });
    return { ok: true, id, token };
  });

  /** One-time enrolment code for `tessera-reporter enrol`. */
  app.post("/devices/enrolment-code", async (req) => {
    const p = req.principal!;
    const code = `${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    await pool.query("INSERT INTO enrolment_codes (code, org_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '15 minutes')", [code, p.orgId, p.userId]);
    return { code, expiresInSeconds: 900, serverUrl: config.publicUrl };
  });

  app.post("/devices/:id/revoke", async (req, reply) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const r = await pool.query<{ token_hash: string }>(
      `UPDATE devices SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL ${canManageOrg(p) ? "" : "AND user_id = $3"} RETURNING token_hash`,
      canManageOrg(p) ? [id, p.orgId] : [id, p.orgId, p.userId],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "no such device" });
    forgetDevice(r.rows[0].token_hash);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "device.revoke", targetType: "device", targetId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- budgets --------------------------------------------------------------
  app.get("/budgets", async (req) => ({ budgets: await budgetStatuses(req.principal!.orgId) }));

  app.put("/budgets", async (req, reply) => {
    const p = admin(req);
    const body = z
      .object({
        scopeType: z.enum(["org", "team", "user"]),
        scopeId: z.string().uuid().nullable().default(null),
        window: z.enum(["daily", "weekly", "monthly"]),
        softUsd: z.number().nonnegative().nullable().default(null),
        hardUsd: z.number().nonnegative().nullable().default(null),
        enforce: z.boolean().default(false),
      })
      .parse(req.body);
    if (body.scopeType !== "org" && !body.scopeId) return reply.code(400).send({ error: "scopeId required for team and user budgets" });
    if (body.softUsd === null && body.hardUsd === null) return reply.code(400).send({ error: "set a soft or hard limit" });
    const r = await pool.query<{ id: string }>(
      `INSERT INTO budgets (org_id, scope_type, scope_id, "window", soft_usd, hard_usd, enforce) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id, scope_type, scope_id, "window") DO UPDATE SET soft_usd = EXCLUDED.soft_usd, hard_usd = EXCLUDED.hard_usd, enforce = EXCLUDED.enforce, updated_at = now()
       RETURNING id`,
      [p.orgId, body.scopeType, body.scopeType === "org" ? null : body.scopeId, body.window, body.softUsd, body.hardUsd, body.enforce],
    );
    invalidateBudgets(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "budget.upsert", targetType: "budget", targetId: r.rows[0]!.id, detail: body, ip: req.ip });
    return { ok: true, id: r.rows[0]!.id };
  });

  app.delete("/budgets/:id", async (req) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    await pool.query("DELETE FROM budgets WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    invalidateBudgets(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "budget.delete", targetType: "budget", targetId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- model prices ---------------------------------------------------------
  app.get("/prices", async (req) => {
    const p = req.principal!;
    const r = await pool.query("SELECT prefix, label, input, output, cache_read, cache_write, updated_at FROM model_prices WHERE org_id = $1 ORDER BY prefix", [p.orgId]);
    return {
      asOf: PRICES_AS_OF,
      builtin: BUILTIN_PRICES,
      overrides: r.rows.map((x) => ({ prefix: x.prefix, label: x.label, input: x.input, output: x.output, cacheRead: x.cache_read, cacheWrite: x.cache_write, updatedAt: x.updated_at })),
    };
  });

  app.put("/prices", async (req) => {
    const p = admin(req);
    const body = z.object({ prefix: z.string().trim().min(2).max(120), label: z.string().trim().min(1).max(120), input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }).parse(req.body);
    await pool.query(
      `INSERT INTO model_prices (org_id, prefix, label, input, output, cache_read, cache_write) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id, prefix) DO UPDATE SET label = EXCLUDED.label, input = EXCLUDED.input, output = EXCLUDED.output, cache_read = EXCLUDED.cache_read, cache_write = EXCLUDED.cache_write, updated_at = now()`,
      [p.orgId, body.prefix, body.label, body.input, body.output, body.cacheRead, body.cacheWrite],
    );
    invalidatePrices(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "price.upsert", targetType: "model", targetId: body.prefix, detail: body, ip: req.ip });
    return { ok: true };
  });

  app.delete("/prices/:prefix", async (req) => {
    const p = admin(req);
    const { prefix } = req.params as { prefix: string };
    await pool.query("DELETE FROM model_prices WHERE org_id = $1 AND prefix = $2", [p.orgId, prefix]);
    invalidatePrices(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "price.delete", targetType: "model", targetId: prefix, ip: req.ip });
    return { ok: true };
  });

  // ---- notification channels ---------------------------------------------------
  app.get("/channels", async (req) => {
    const p = admin(req);
    const r = await pool.query("SELECT id, kind, name, events, enabled, created_at, last_sent_at, last_error FROM notification_channels WHERE org_id = $1 ORDER BY created_at", [p.orgId]);
    return { channels: r.rows.map((c) => ({ id: c.id, kind: c.kind, name: c.name, events: c.events, enabled: c.enabled, createdAt: c.created_at, lastSentAt: c.last_sent_at, lastError: c.last_error })) };
  });

  const EventList = z.array(z.enum(["session.waiting", "agent.failed", "budget.breach", "context.blowout", "session.stale"]));

  app.post("/channels", async (req, reply) => {
    const p = admin(req);
    const body = z.object({ kind: z.enum(["slack_webhook", "webhook"]), name: z.string().trim().min(1).max(100), url: z.string().url().max(1000), events: EventList.default(["session.waiting", "agent.failed", "budget.breach", "context.blowout"]) }).parse(req.body);
    if (!body.url.startsWith("https://")) return reply.code(400).send({ error: "Webhook URLs must use https." });
    const r = await pool.query<{ id: string }>("INSERT INTO notification_channels (org_id, kind, name, url_enc, events) VALUES ($1,$2,$3,$4,$5) RETURNING id", [p.orgId, body.kind, body.name, encrypt(body.url), JSON.stringify(body.events)]);
    invalidateChannels(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "channel.create", targetType: "channel", targetId: r.rows[0]!.id, detail: { kind: body.kind, name: body.name, events: body.events }, ip: req.ip });
    return { ok: true, id: r.rows[0]!.id };
  });

  app.patch("/channels/:id", async (req) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean().optional(), events: EventList.optional(), name: z.string().trim().min(1).max(100).optional() }).parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [id, p.orgId];
    if (body.enabled !== undefined) sets.push(`enabled = $${params.push(body.enabled)}`);
    if (body.events !== undefined) sets.push(`events = $${params.push(JSON.stringify(body.events))}`);
    if (body.name !== undefined) sets.push(`name = $${params.push(body.name)}`);
    if (sets.length) await pool.query(`UPDATE notification_channels SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2`, params);
    invalidateChannels(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "channel.update", targetType: "channel", targetId: id, detail: body, ip: req.ip });
    return { ok: true };
  });

  app.delete("/channels/:id", async (req) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    await pool.query("DELETE FROM notification_channels WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    invalidateChannels(p.orgId);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "channel.delete", targetType: "channel", targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.post("/channels/:id/test", async (req) => {
    const p = admin(req);
    const { id } = req.params as { id: string };
    await pool.query("DELETE FROM notification_log WHERE channel_id = $1 AND dedupe_key LIKE 'test:%'", [id]);
    await notify(p.orgId, { event: "session.waiting", dedupeKey: `test:${Date.now()}`, title: "Tessera test notification", text: `Sent by ${p.name}. If you can read this, the channel works.` }, req.log);
    const r = await pool.query<{ last_error: string | null }>("SELECT last_error FROM notification_channels WHERE id = $1", [id]);
    return { ok: true, error: r.rows[0]?.last_error ?? null };
  });

  // ---- audit ------------------------------------------------------------------
  app.get("/audit", async (req) => {
    const p = admin(req);
    const q = z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().max(60).optional() }).parse(req.query);
    const params: unknown[] = [p.orgId, q.limit];
    let where = "org_id = $1";
    if (q.before) where += ` AND id < $${params.push(q.before)}`;
    if (q.action) where += ` AND action LIKE $${params.push(`${q.action}%`)}`;
    const r = await pool.query(`SELECT id, actor_id, actor_name, action, target_type, target_id, detail, ip, created_at, hash FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
    return { entries: r.rows.map((e) => ({ id: e.id, actorId: e.actor_id, actorName: e.actor_name, action: e.action, targetType: e.target_type, targetId: e.target_id, detail: e.detail, ip: e.ip, createdAt: e.created_at, hash: e.hash })) };
  });

  app.get("/audit/verify", async (req) => verifyChain(admin(req).orgId));

  // ---- spend ------------------------------------------------------------------
  app.get("/spend", async (req) => {
    const p = req.principal!;
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
    const r = await pool.query<{ day: string; owner_id: string | null; owner_name: string | null; team_name: string | null; cost: number; sessions: number }>(
      `WITH daily AS (
         SELECT date_trunc('day', sa.ts) AS day, sa.session_id,
                MAX(sa.cost_usd) - COALESCE((SELECT MAX(p.cost_usd) FROM samples p WHERE p.org_id = sa.org_id AND p.session_id = sa.session_id AND p.ts < date_trunc('day', sa.ts)), 0) AS cost
           FROM samples sa WHERE sa.org_id = $1 AND sa.ts > now() - ($2 || ' days')::interval
          GROUP BY 1, 2)
       SELECT d.day, s.owner_id, u.name AS owner_name, t.name AS team_name, SUM(GREATEST(d.cost, 0))::numeric AS cost, COUNT(DISTINCT d.session_id)::int AS sessions
         FROM daily d JOIN sessions s ON s.org_id = $1 AND s.id = d.session_id
         LEFT JOIN users u ON u.id = s.owner_id LEFT JOIN teams t ON t.id = s.team_id
        GROUP BY 1, 2, 3, 4 ORDER BY 1 ASC`,
      [p.orgId, String(q.days)],
    );
    return { rows: r.rows.map((x) => ({ day: x.day, ownerId: x.owner_id, ownerName: x.owner_name, teamName: x.team_name, costUsd: Number(x.cost), sessions: x.sessions })) };
  });
}
