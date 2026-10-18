import { decrypt } from "../auth/crypto.js";
import { pool } from "../db/pool.js";

export type StreamFormat = "ndjson" | "splunk_hec" | "json_array";

export interface AuditRow {
  id: string;
  org_id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  prev_hash: string | null;
  hash: string;
}

/** One audit entry as it leaves Tessera: stable field names, with the hash chain so a SIEM can check it too. */
export const entryOut = (e: AuditRow) => ({
  id: Number(e.id),
  time: new Date(e.created_at).toISOString(),
  orgId: e.org_id,
  actorId: e.actor_id,
  actor: e.actor_name,
  action: e.action,
  targetType: e.target_type,
  targetId: e.target_id,
  detail: e.detail,
  ip: e.ip,
  prevHash: e.prev_hash,
  hash: e.hash,
});

export function body(format: StreamFormat, rows: AuditRow[]): { body: string; contentType: string } {
  const entries = rows.map(entryOut);
  if (format === "splunk_hec") {
    return { body: entries.map((e) => JSON.stringify({ time: Date.parse(e.time) / 1000, source: "tessera", sourcetype: "tessera:audit", event: e })).join("\n"), contentType: "application/json" };
  }
  if (format === "json_array") return { body: JSON.stringify(entries.map((e) => ({ ddsource: "tessera", service: "tessera", ...e }))), contentType: "application/json" };
  return { body: `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, contentType: "application/x-ndjson" };
}

export async function send(url: string, format: StreamFormat, header: { name: string; value: string } | null, rows: AuditRow[]): Promise<void> {
  const b = body(format, rows);
  const res = await fetch(url, { method: "POST", headers: { "content-type": b.contentType, ...(header ? { [header.name]: header.value } : {}) }, body: b.body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

interface StreamRow {
  org_id: string;
  url_enc: string;
  header_name: string | null;
  header_value_enc: string | null;
  format: StreamFormat;
  cursor: string;
}

/**
 * Deliver new audit entries to each organisation's SIEM, in order, at least
 * once. Rows are locked while sent so replicas never send the same batch; a
 * failing destination is retried on the next round from the same cursor.
 */
export async function pumpAuditStreams(log: { warn: (o: object, m: string) => void }): Promise<number> {
  const c = await pool.connect();
  let sent = 0;
  try {
    await c.query("BEGIN");
    const streams = await c.query<StreamRow>("SELECT org_id, url_enc, header_name, header_value_enc, format, cursor FROM audit_streams WHERE enabled FOR UPDATE SKIP LOCKED");
    for (const s of streams.rows) {
      const rows = await c.query<AuditRow>("SELECT * FROM audit_log WHERE org_id = $1 AND id > $2 ORDER BY id ASC LIMIT 500", [s.org_id, s.cursor]);
      if (!rows.rowCount) continue;
      try {
        await send(decrypt(s.url_enc), s.format, s.header_name && s.header_value_enc ? { name: s.header_name, value: decrypt(s.header_value_enc) } : null, rows.rows);
        await c.query("UPDATE audit_streams SET cursor = $2, last_sent_at = now(), last_error = NULL WHERE org_id = $1", [s.org_id, rows.rows.at(-1)!.id]);
        sent += rows.rowCount ?? 0;
      } catch (e) {
        log.warn({ org: s.org_id, err: (e as Error).message }, "audit stream delivery failed");
        await c.query("UPDATE audit_streams SET last_error = $2 WHERE org_id = $1", [s.org_id, (e as Error).message.slice(0, 300)]);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return sent;
}
