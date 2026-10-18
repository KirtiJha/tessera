import { decrypt } from "../auth/crypto.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export type NotifyEvent = "session.waiting" | "agent.failed" | "budget.breach" | "context.blowout" | "session.stale";

export interface Notification {
  event: NotifyEvent;
  /** Same key within a channel sends once. */
  dedupeKey: string;
  title: string;
  text: string;
  sessionId?: string;
  fields?: Record<string, string>;
}

interface Channel {
  id: string;
  kind: "slack_webhook" | "webhook";
  name: string;
  url_enc: string;
  events: string[];
}

const chanCache = new Map<string, { list: Channel[]; until: number }>();

export function invalidateChannels(orgId: string): void {
  chanCache.delete(orgId);
}

async function channelsFor(orgId: string): Promise<Channel[]> {
  const hit = chanCache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.list;
  const r = await pool.query<Channel>("SELECT id, kind, name, url_enc, events FROM notification_channels WHERE org_id = $1 AND enabled", [orgId]);
  chanCache.set(orgId, { list: r.rows, until: Date.now() + 30_000 });
  return r.rows;
}

function slackPayload(n: Notification): unknown {
  const link = n.sessionId ? `${config.publicUrl}/app/sessions/${encodeURIComponent(n.sessionId)}` : config.publicUrl;
  const fields = Object.entries(n.fields ?? {}).map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v}` }));
  return {
    text: `${n.title} — ${n.text}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: n.title.slice(0, 150) } },
      { type: "section", text: { type: "mrkdwn", text: n.text.slice(0, 2900) } },
      ...(fields.length ? [{ type: "section", fields: fields.slice(0, 10) }] : []),
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Tessera" }, url: link }] },
    ],
  };
}

export async function notify(orgId: string, n: Notification, log: { warn: (o: object, m: string) => void }): Promise<void> {
  const channels = await channelsFor(orgId);
  for (const c of channels) {
    if (!c.events.includes(n.event)) continue;
    const ins = await pool.query(
      "INSERT INTO notification_log (org_id, channel_id, event, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [orgId, c.id, n.event, n.dedupeKey],
    );
    if (!ins.rowCount) continue;
    const url = decrypt(c.url_enc);
    const body = c.kind === "slack_webhook" ? slackPayload(n) : { ...n, sentAt: new Date().toISOString() };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      await pool.query("UPDATE notification_channels SET last_sent_at = now(), last_error = $2 WHERE id = $1", [
        c.id,
        res.ok ? null : `HTTP ${res.status}`,
      ]);
    } catch (e) {
      log.warn({ channel: c.name, err: (e as Error).message }, "notification failed");
      await pool.query("UPDATE notification_channels SET last_error = $2 WHERE id = $1", [c.id, (e as Error).message.slice(0, 300)]);
    }
  }
}
