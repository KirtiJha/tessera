import { createHmac } from "node:crypto";
import { decrypt } from "../auth/crypto.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { appMessage, resolvedMessage, sessionLink, slackApi, webhookMessage } from "./slack.js";

export type NotifyEvent = "session.waiting" | "agent.failed" | "budget.breach" | "context.blowout" | "session.stale" | "policy.denied";
export const NOTIFY_EVENTS: NotifyEvent[] = ["session.waiting", "agent.failed", "budget.breach", "context.blowout", "session.stale", "policy.denied"];

export type ChannelKind = "slack_webhook" | "slack_app" | "teams_webhook" | "pagerduty" | "webhook";
export const CHANNEL_KINDS: ChannelKind[] = ["slack_webhook", "slack_app", "teams_webhook", "pagerduty", "webhook"];

export interface Notification {
  event: NotifyEvent;
  /** Same key within a channel sends once. */
  dedupeKey: string;
  title: string;
  text: string;
  sessionId?: string;
  fields?: Record<string, string>;
  /** The open prompt, when the notification is about one: lets chat apps answer it. */
  ask?: { id: string; kind: "question" | "plan" | "permission" };
  severity?: "critical" | "error" | "warning" | "info";
}

export interface ChannelSecrets {
  botToken?: string;
  signingSecret?: string;
  channel?: string;
  routingKey?: string;
}

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  url_enc: string | null;
  secret_enc: string | null;
  events: string[];
  delay_s: number;
}

interface Log {
  warn: (o: object, m: string) => void;
}

const chanCache = new Map<string, { list: ChannelRow[]; until: number }>();
/** channel|dedupeKey already sent by this process: keeps repeated (delayed) checks off the database. */
const sent = new Set<string>();

export function invalidateChannels(orgId: string): void {
  chanCache.delete(orgId);
}

async function channelsFor(orgId: string): Promise<ChannelRow[]> {
  const hit = chanCache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.list;
  const r = await pool.query<ChannelRow>("SELECT id, kind, name, url_enc, secret_enc, events, delay_s FROM notification_channels WHERE org_id = $1 AND enabled", [orgId]);
  chanCache.set(orgId, { list: r.rows, until: Date.now() + 30_000 });
  return r.rows;
}

export function secretsOf(c: { secret_enc: string | null }): ChannelSecrets {
  return c.secret_enc ? (JSON.parse(decrypt(c.secret_enc)) as ChannelSecrets) : {};
}

/** Does this org have a channel that waits before it notifies? The fleet only re-checks waiting sessions when one does. */
export async function hasDelayedChannels(orgId: string): Promise<boolean> {
  return (await channelsFor(orgId)).some((c) => c.delay_s > 0 && c.events.includes("session.waiting"));
}

// ---- payloads ------------------------------------------------------------------

function teamsCard(n: Notification): unknown {
  const facts = Object.entries(n.fields ?? {}).map(([title, value]) => ({ title, value }));
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: n.title, weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: n.text.slice(0, 2000), wrap: true },
            ...(facts.length ? [{ type: "FactSet", facts }] : []),
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open in Tessera", url: sessionLink(n.sessionId) }],
        },
      },
    ],
  };
}

function severityOf(n: Notification): "critical" | "error" | "warning" | "info" {
  if (n.severity) return n.severity;
  if (n.event === "budget.breach" || n.event === "agent.failed") return "error";
  if (n.event === "session.waiting" || n.event === "session.stale" || n.event === "policy.denied") return "warning";
  return "info";
}

function pagerdutyEvent(routingKey: string, n: Notification, action: "trigger" | "resolve"): unknown {
  return {
    routing_key: routingKey,
    event_action: action,
    dedup_key: n.dedupeKey.slice(0, 255),
    ...(action === "trigger"
      ? {
          payload: { summary: `${n.title}: ${n.text}`.slice(0, 1024), source: config.publicHost, severity: severityOf(n), component: "tessera", class: n.event, custom_details: n.fields ?? {} },
          links: [{ href: sessionLink(n.sessionId), text: "Open in Tessera" }],
        }
      : {}),
  };
}

/** Signed webhook: X-Tessera-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signWebhook(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}

/** Deliver one notification to one channel. Returns where it landed, for later updates. */
async function deliver(c: ChannelRow, n: Notification): Promise<Record<string, unknown> | null> {
  const s = secretsOf(c);
  switch (c.kind) {
    case "slack_app": {
      if (!s.botToken || !s.channel) throw new Error("Slack app channel is missing its bot token or channel");
      const msg = appMessage(n, c.id);
      const r = await slackApi<{ channel: string; ts: string }>(s.botToken, "chat.postMessage", { channel: s.channel, ...msg, unfurl_links: false });
      return { channel: r.channel, ts: r.ts, title: n.title, text: n.text, fields: n.fields ?? {}, sessionId: n.sessionId ?? null };
    }
    case "pagerduty": {
      if (!s.routingKey) throw new Error("PagerDuty channel is missing its routing key");
      const res = await post(config.pagerdutyEventsUrl, pagerdutyEvent(s.routingKey, n, "trigger"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { dedupKey: n.dedupeKey.slice(0, 255) };
    }
    case "teams_webhook":
    case "slack_webhook":
    case "webhook": {
      if (!c.url_enc) throw new Error("channel has no URL");
      const url = decrypt(c.url_enc);
      const body = JSON.stringify(c.kind === "slack_webhook" ? webhookMessage(n) : c.kind === "teams_webhook" ? teamsCard(n) : { ...n, link: sessionLink(n.sessionId), sentAt: new Date().toISOString() });
      const headers: Record<string, string> = c.kind === "webhook" && s.signingSecret ? { "x-tessera-signature": signWebhook(s.signingSecret, body), "x-tessera-event": n.event } : {};
      const res = await post(url, body, headers);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return null;
    }
  }
}

/**
 * Send a notification to every enabled channel of the org that wants this
 * event. A channel with a delay only gets session.waiting once the session has
 * waited that long; `waitedMs` says how long it has (0 on first sight).
 */
export async function notify(orgId: string, n: Notification, log: Log, opts: { waitedMs?: number } = {}): Promise<void> {
  const waited = opts.waitedMs ?? 0;
  for (const c of await channelsFor(orgId)) {
    if (!c.events.includes(n.event)) continue;
    if (n.event === "session.waiting" && c.delay_s * 1000 > waited) continue;
    const mark = `${c.id}|${n.dedupeKey}`;
    if (sent.has(mark)) continue;
    if (sent.size > 50_000) sent.clear();
    sent.add(mark);
    const ins = await pool.query<{ id: string }>(
      "INSERT INTO notification_log (org_id, channel_id, event, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
      [orgId, c.id, n.event, n.dedupeKey],
    );
    const logId = ins.rows[0]?.id;
    if (!logId) continue;
    try {
      const ref = await deliver(c, n);
      if (ref) await pool.query("UPDATE notification_log SET external_ref = $2 WHERE id = $1", [logId, JSON.stringify(ref)]);
      await pool.query("UPDATE notification_channels SET last_sent_at = now(), last_error = NULL WHERE id = $1", [c.id]);
    } catch (e) {
      log.warn({ channel: c.name, err: (e as Error).message }, "notification failed");
      await pool.query("UPDATE notification_channels SET last_error = $2 WHERE id = $1", [c.id, (e as Error).message.slice(0, 300)]);
    }
  }
}

/**
 * The thing a notification was about is over (the prompt was answered, the
 * session moved on): take the buttons off its Slack messages and say who
 * closed it, and resolve its PagerDuty incident. Safe to call more than once.
 */
export async function resolveNotifications(orgId: string, dedupeKey: string, outcome: string, log: Log): Promise<void> {
  const r = await pool.query<{ id: string; external_ref: Record<string, unknown> | null } & ChannelRow>(
    `UPDATE notification_log l SET resolved_at = now()
       FROM notification_channels c
      WHERE l.org_id = $1 AND l.dedupe_key = $2 AND l.resolved_at IS NULL AND c.id = l.channel_id AND c.kind IN ('slack_app', 'pagerduty')
      RETURNING l.id, l.external_ref, c.kind, c.name, c.secret_enc, c.url_enc, c.events, c.delay_s, c.id AS channel_id`,
    [orgId, dedupeKey],
  );
  for (const row of r.rows) {
    try {
      const s = secretsOf(row);
      const ref = row.external_ref ?? {};
      if (row.kind === "slack_app" && s.botToken && typeof ref.channel === "string" && typeof ref.ts === "string") {
        const msg = resolvedMessage({ title: String(ref.title ?? ""), text: String(ref.text ?? ""), fields: (ref.fields as Record<string, string>) ?? {}, sessionId: (ref.sessionId as string) ?? undefined }, outcome);
        await slackApi(s.botToken, "chat.update", { channel: ref.channel, ts: ref.ts, ...msg });
      } else if (row.kind === "pagerduty" && s.routingKey) {
        await post(config.pagerdutyEventsUrl, pagerdutyEvent(s.routingKey, { event: "session.waiting", dedupeKey, title: "", text: "" }, "resolve"));
      }
    } catch (e) {
      log.warn({ channel: row.name, err: (e as Error).message }, "notification resolve failed");
    }
  }
}

/** Send a test message to one channel, bypassing event filters and delays. */
export async function testChannel(orgId: string, channelId: string, by: string): Promise<string | null> {
  const r = await pool.query<ChannelRow>("SELECT id, kind, name, url_enc, secret_enc, events, delay_s FROM notification_channels WHERE id = $1 AND org_id = $2", [channelId, orgId]);
  const c = r.rows[0];
  if (!c) return "no such channel";
  try {
    if (c.kind === "slack_app") {
      const s = secretsOf(c);
      if (!s.botToken) return "missing bot token";
      await slackApi(s.botToken, "auth.test", {});
    }
    const n: Notification = { event: "session.waiting", dedupeKey: `test:${Date.now()}`, title: "Tessera test notification", text: `Sent by ${by}. If you can read this, the channel works.`, severity: "info" };
    await deliver(c, n);
    if (c.kind === "pagerduty") {
      const s = secretsOf(c);
      // A test should not leave an open incident behind.
      await post(config.pagerdutyEventsUrl, pagerdutyEvent(s.routingKey!, n, "resolve"));
    }
    await pool.query("UPDATE notification_channels SET last_sent_at = now(), last_error = NULL WHERE id = $1", [c.id]);
    return null;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await pool.query("UPDATE notification_channels SET last_error = $2 WHERE id = $1", [c.id, msg]);
    return msg;
  }
}
