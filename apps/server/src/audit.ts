import { sha256 } from "./auth/crypto.js";
import { pool, type Queryable } from "./db/pool.js";

export interface AuditInput {
  orgId: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/**
 * Append-only, hash-chained audit log. Each row's hash covers its own content
 * and the previous row's hash for the org, so a removed or edited row breaks
 * the chain. `verifyChain` walks it.
 */
export async function audit(input: AuditInput, q: Queryable = pool): Promise<void> {
  const prev = await q.query<{ hash: string }>("SELECT hash FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT 1", [input.orgId]);
  const prevHash = prev.rows[0]?.hash ?? null;
  const createdAt = new Date().toISOString();
  const detail = input.detail ?? {};
  const hash = sha256(
    JSON.stringify([prevHash, input.orgId, input.actorId, input.actorName, input.action, input.targetType ?? null, input.targetId ?? null, detail, createdAt]),
  );
  await q.query(
    `INSERT INTO audit_log (org_id, actor_id, actor_name, action, target_type, target_id, detail, ip, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.orgId, input.actorId, input.actorName, input.action, input.targetType ?? null, input.targetId ?? null, detail, input.ip ?? null, createdAt, prevHash, hash],
  );
}

export async function verifyChain(orgId: string): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
  const r = await pool.query<{
    id: number;
    actor_id: string | null;
    actor_name: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail: Record<string, unknown>;
    created_at: string;
    prev_hash: string | null;
    hash: string;
  }>("SELECT * FROM audit_log WHERE org_id = $1 ORDER BY id ASC", [orgId]);
  let prev: string | null = null;
  for (const row of r.rows) {
    const expect = sha256(
      JSON.stringify([prev, orgId, row.actor_id, row.actor_name, row.action, row.target_type, row.target_id, row.detail, row.created_at]),
    );
    if (row.prev_hash !== prev || row.hash !== expect) return { ok: false, checked: r.rows.length, brokenAt: row.id };
    prev = row.hash;
  }
  return { ok: true, checked: r.rows.length, brokenAt: null };
}
