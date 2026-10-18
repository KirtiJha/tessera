import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { sha256 } from "./crypto.js";
import { atLeast, type Principal, type Role } from "./rbac.js";

export const SCOPES = ["fleet:read", "sessions:act", "analytics:read", "audit:read", "policy:read", "policy:write"] as const;
export type Scope = (typeof SCOPES)[number];

/** Least role a person needs to hold a scope; a key never grants more than its maker could do. */
export const SCOPE_MIN_ROLE: Record<Scope, Role> = {
  "fleet:read": "viewer",
  "sessions:act": "operator",
  "analytics:read": "viewer",
  "audit:read": "admin",
  "policy:read": "admin",
  "policy:write": "admin",
};

export interface ApiKeyInfo {
  id: string;
  name: string;
  scopes: Scope[];
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyInfo | null;
  }
}

const cache = new Map<string, { v: { p: Principal; key: ApiKeyInfo } | null; until: number }>();
const touched = new Map<string, number>();

export function forgetApiKeys(): void {
  cache.clear();
}

/**
 * Resolve a bearer API key to the person who made it. The key carries that
 * person's current role (so demoting or disabling them reaches their keys at
 * once, within the 15 s cache) and is limited to its scopes.
 */
export async function principalFromApiKey(req: FastifyRequest): Promise<{ p: Principal; key: ApiKeyInfo } | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer tsk_")) return null;
  const h = sha256(auth.slice(7).trim());
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.v;
  const r = await pool.query<{ id: string; name: string; scopes: Scope[]; user_id: string; org_id: string; team_id: string | null; role: Role; uname: string; email: string }>(
    `SELECT k.id, k.name, k.scopes, u.id AS user_id, u.org_id, u.team_id, u.role, u.name AS uname, u.email
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.status = 'active'`,
    [h],
  );
  const row = r.rows[0];
  const v = row
    ? {
        p: { userId: row.user_id, orgId: row.org_id, teamId: row.team_id, role: row.role, name: `${row.uname} (API key ${row.name})`, email: row.email },
        key: { id: row.id, name: row.name, scopes: row.scopes.filter((s) => atLeast(row.role, SCOPE_MIN_ROLE[s] ?? "owner")) },
      }
    : null;
  cache.set(h, { v, until: Date.now() + 15_000 });
  if (v && Date.now() - (touched.get(v.key.id) ?? 0) > 60_000) {
    touched.set(v.key.id, Date.now());
    void pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [v.key.id]).catch(() => {});
  }
  return v;
}

/**
 * Which scope a request needs when it comes with an API key, or null when API
 * keys may not call it at all (sign-in, people, settings, SSO, devices...).
 */
export function scopeFor(method: string, url: string): Scope | "any" | null {
  const path = url.split("?")[0]!;
  // Who am I: any valid key may ask.
  if (path === "/api/auth/me" && method === "GET") return "any";
  const read = method === "GET" || method === "HEAD";
  if (path.startsWith("/api/fleet/")) {
    if (read) return "fleet:read";
    if (/^\/api\/fleet\/sessions\/[^/]+\/(answer|message|pause|stop|assign)$/.test(path)) return "sessions:act";
    return null;
  }
  if (path === "/api/analytics" || path.startsWith("/api/analytics/")) return read && path !== "/api/analytics/settings" ? "analytics:read" : null;
  if (path.startsWith("/api/admin/audit")) return read ? "audit:read" : null;
  if (path === "/api/admin/policy" || path.startsWith("/api/admin/policy/")) return read ? "policy:read" : path.endsWith("/test") ? "policy:read" : "policy:write";
  return null;
}
