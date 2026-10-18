import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { newToken, sha256 } from "./crypto.js";

export interface DevicePrincipal {
  deviceId: string;
  orgId: string;
  userId: string;
  userName: string;
  teamId: string | null;
  label: string;
}

const cache = new Map<string, { p: DevicePrincipal; until: number }>();

export async function deviceFromRequest(req: FastifyRequest): Promise<DevicePrincipal | null> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : (req.headers["x-tessera-token"] as string | undefined);
  if (!token || !token.startsWith("tsr_")) return null;
  const h = sha256(token);
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.p;
  const r = await pool.query<{ id: string; org_id: string; user_id: string; name: string; team_id: string | null; label: string }>(
    `SELECT d.id, d.org_id, d.user_id, u.name, u.team_id, d.label
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND u.status = 'active'`,
    [h],
  );
  const row = r.rows[0];
  if (!row) {
    cache.delete(h);
    return null;
  }
  const p: DevicePrincipal = { deviceId: row.id, orgId: row.org_id, userId: row.user_id, userName: row.name, teamId: row.team_id, label: row.label };
  cache.set(h, { p, until: Date.now() + 30_000 });
  return p;
}

export function forgetDevice(tokenHash: string): void {
  cache.delete(tokenHash);
}

export async function issueDevice(orgId: string, userId: string, label: string): Promise<{ id: string; token: string }> {
  const token = newToken("tsr");
  const r = await pool.query<{ id: string }>(
    "INSERT INTO devices (org_id, user_id, label, token_hash) VALUES ($1, $2, $3, $4) RETURNING id",
    [orgId, userId, label.slice(0, 120), sha256(token)],
  );
  return { id: r.rows[0]!.id, token };
}
