import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { newToken, sha256 } from "./crypto.js";
import type { Principal, Role } from "./rbac.js";

export const COOKIE = "tessera_session";
const TTL_MS = 12 * 60 * 60 * 1000;

export async function createUserSession(userId: string, ip: string | undefined, ua: string | undefined): Promise<string> {
  const token = newToken("tss");
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4, $5)`,
    [sha256(token), userId, String(TTL_MS), ip ?? null, ua?.slice(0, 300) ?? null],
  );
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.isProd,
    maxAge: TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}

export async function destroyUserSession(token: string): Promise<void> {
  await pool.query("DELETE FROM user_sessions WHERE id = $1", [sha256(token)]);
}

interface Row {
  user_id: string;
  org_id: string;
  team_id: string | null;
  role: Role;
  name: string;
  email: string;
  status: string;
}

export async function principalFromRequest(req: FastifyRequest): Promise<Principal | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const r = await pool.query<Row>(
    `UPDATE user_sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.id = $1 AND s.user_id = u.id AND s.expires_at > now() AND u.status = 'active'
      RETURNING u.id AS user_id, u.org_id, u.team_id, u.role, u.name, u.email, u.status`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { userId: row.user_id, orgId: row.org_id, teamId: row.team_id, role: row.role, name: row.name, email: row.email };
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<Principal> {
  if (!req.principal) {
    reply.code(401);
    throw Object.assign(new Error("sign in required"), { statusCode: 401 });
  }
  return req.principal;
}

/** Mutating browser requests must carry the custom header (CSRF) and a same-origin Origin when present. */
export function checkMutation(req: FastifyRequest): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  if (req.headers["x-tessera-client"] !== "web") {
    throw Object.assign(new Error("missing X-Tessera-Client header"), { statusCode: 403 });
  }
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw Object.assign(new Error("bad origin"), { statusCode: 403 });
    }
    const ok = host === req.headers.host || host === config.publicHost || config.allowedHosts.includes(host);
    if (!ok) throw Object.assign(new Error("cross-origin request refused"), { statusCode: 403 });
  }
}
