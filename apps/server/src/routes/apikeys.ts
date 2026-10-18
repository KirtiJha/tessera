import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { forgetApiKeys, SCOPE_MIN_ROLE, SCOPES, type Scope } from "../auth/apikeys.js";
import { newToken, sha256 } from "../auth/crypto.js";
import { atLeast, canManageOrg } from "../auth/rbac.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { pool } from "../db/pool.js";

/** People make API keys for themselves; admins see and revoke every key in the org. */
export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  app.get("/", async (req) => {
    const p = req.principal!;
    const all = canManageOrg(p);
    const r = await pool.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.expires_at, k.last_used_at, k.revoked_at, u.name AS owner, k.user_id
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.org_id = $1 ${all ? "" : "AND k.user_id = $2"} ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
      all ? [p.orgId] : [p.orgId, p.userId],
    );
    return {
      scopes: SCOPES.map((s) => ({ scope: s, allowed: atLeast(p.role, SCOPE_MIN_ROLE[s]), minRole: SCOPE_MIN_ROLE[s] })),
      keys: r.rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: k.created_at, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, owner: k.owner, mine: k.user_id === p.userId })),
    };
  });

  app.post("/", async (req, reply) => {
    const p = req.principal!;
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
      expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
    }).parse(req.body);
    const denied = body.scopes.filter((s: Scope) => !atLeast(p.role, SCOPE_MIN_ROLE[s]));
    if (denied.length) return reply.code(403).send({ error: `Your role cannot grant ${denied.join(", ")}.` });
    const token = newToken("tsk");
    const r = await pool.query<{ id: string }>(
      "INSERT INTO api_keys (org_id, user_id, name, prefix, token_hash, scopes, expires_at) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END) RETURNING id",
      [p.orgId, p.userId, body.name, token.slice(0, 12), sha256(token), [...new Set(body.scopes)], body.expiresInDays],
    );
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "apikey.create", targetType: "apikey", targetId: r.rows[0]!.id, detail: { name: body.name, scopes: body.scopes, expiresInDays: body.expiresInDays }, ip: req.ip });
    return { ok: true, id: r.rows[0]!.id, token };
  });

  app.delete("/:id", async (req, reply) => {
    const p = req.principal!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL ${canManageOrg(p) ? "" : "AND user_id = $3"} RETURNING name`,
      canManageOrg(p) ? [id, p.orgId] : [id, p.orgId, p.userId],
    );
    if (!r.rowCount) return reply.code(404).send({ error: "No such key." });
    forgetApiKeys();
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "apikey.revoke", targetType: "apikey", targetId: id, detail: { name: r.rows[0].name }, ip: req.ip });
    return { ok: true };
  });
}
