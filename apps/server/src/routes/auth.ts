import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { hashPassword, newToken, sha256, verifyPassword } from "../auth/crypto.js";
import { checkMutation, clearSessionCookie, COOKIE, createUserSession, destroyUserSession, requireUser, setSessionCookie } from "../auth/session.js";
import { pool, withTx } from "../db/pool.js";

const Email = z.string().trim().toLowerCase().email().max(200);
const Password = z.string().min(10).max(200);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "org";
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req) => checkMutation(req));

  app.post("/signup", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({ orgName: z.string().trim().min(2).max(100), name: z.string().trim().min(1).max(100), email: Email, password: Password }).parse(req.body);
    const existing = await pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
    if (existing.rowCount) return reply.code(409).send({ error: "An account with that email already exists. Sign in instead." });
    const hash = await hashPassword(body.password);
    const { userId, orgId } = await withTx(async (c) => {
      let slug = slugify(body.orgName);
      const taken = await c.query("SELECT 1 FROM orgs WHERE slug = $1", [slug]);
      if (taken.rowCount) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      const org = await c.query<{ id: string }>("INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id", [body.orgName, slug]);
      const orgId = org.rows[0]!.id;
      const user = await c.query<{ id: string }>(
        "INSERT INTO users (org_id, email, name, password_hash, role, status, last_login_at) VALUES ($1,$2,$3,$4,'owner','active',now()) RETURNING id",
        [orgId, body.email, body.name, hash],
      );
      const userId = user.rows[0]!.id;
      await audit({ orgId, actorId: userId, actorName: body.name, action: "org.create", targetType: "org", targetId: orgId, detail: { name: body.orgName }, ip: req.ip }, c);
      return { userId, orgId };
    });
    const token = await createUserSession(userId, req.ip, req.headers["user-agent"]);
    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post("/signin", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const body = z.object({ email: Email, password: z.string().max(200) }).parse(req.body);
    const r = await pool.query<{ id: string; org_id: string; name: string; password_hash: string | null; status: string }>(
      "SELECT id, org_id, name, password_hash, status FROM users WHERE lower(email) = $1",
      [body.email],
    );
    const u = r.rows[0];
    const ok = u ? await verifyPassword(body.password, u.password_hash) : await verifyPassword(body.password, "scrypt$AA$AA");
    if (!u || !ok || u.status !== "active") {
      await new Promise((res) => setTimeout(res, 300));
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [u.id]);
    const token = await createUserSession(u.id, req.ip, req.headers["user-agent"]);
    setSessionCookie(reply, token);
    await audit({ orgId: u.org_id, actorId: u.id, actorName: u.name, action: "user.signin", ip: req.ip });
    return { ok: true };
  });

  app.post("/signout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await destroyUserSession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/me", async (req, reply) => {
    const p = await requireUser(req, reply);
    const org = await pool.query<{ name: string; slug: string; settings: Record<string, unknown> }>("SELECT name, slug, settings FROM orgs WHERE id = $1", [p.orgId]);
    const team = p.teamId ? await pool.query<{ name: string }>("SELECT name FROM teams WHERE id = $1", [p.teamId]) : null;
    return {
      user: { id: p.userId, name: p.name, email: p.email, role: p.role, teamId: p.teamId, teamName: team?.rows[0]?.name ?? null },
      org: { id: p.orgId, name: org.rows[0]?.name, slug: org.rows[0]?.slug },
    };
  });

  // Invitation: an admin creates an invite; the invitee sets a password with the token.
  app.get("/invite/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const r = await pool.query<{ email: string; name: string; org: string }>(
      "SELECT u.email, u.name, o.name AS org FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.invite_token_hash = $1 AND u.status = 'invited'",
      [sha256(token)],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "This invitation is not valid any more." });
    return r.rows[0];
  });

  app.post("/invite/:token/accept", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const body = z.object({ name: z.string().trim().min(1).max(100), password: Password }).parse(req.body);
    const r = await pool.query<{ id: string; org_id: string }>(
      `UPDATE users SET name = $2, password_hash = $3, status = 'active', invite_token_hash = NULL, last_login_at = now()
        WHERE invite_token_hash = $1 AND status = 'invited' RETURNING id, org_id`,
      [sha256(token), body.name, await hashPassword(body.password)],
    );
    const u = r.rows[0];
    if (!u) return reply.code(404).send({ error: "This invitation is not valid any more." });
    const st = await createUserSession(u.id, req.ip, req.headers["user-agent"]);
    setSessionCookie(reply, st);
    await audit({ orgId: u.org_id, actorId: u.id, actorName: body.name, action: "user.invite.accept", targetType: "user", targetId: u.id, ip: req.ip });
    return { ok: true };
  });

  app.post("/password", async (req, reply) => {
    const p = await requireUser(req, reply);
    const body = z.object({ current: z.string().max(200), next: Password }).parse(req.body);
    const r = await pool.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [p.userId]);
    if (!(await verifyPassword(body.current, r.rows[0]?.password_hash ?? null))) return reply.code(400).send({ error: "Current password is wrong." });
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [p.userId, await hashPassword(body.next)]);
    await pool.query("DELETE FROM user_sessions WHERE user_id = $1 AND id <> $2", [p.userId, sha256(req.cookies[COOKIE] ?? "")]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.password.change", ip: req.ip });
    return { ok: true };
  });
}

export { newToken };
