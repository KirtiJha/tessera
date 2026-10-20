import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { Notification } from "./notifier.js";

/** What a button carries back to Tessera. Slack echoes it untouched; the request signature proves it came through Slack. */
export interface ActionValue {
  /** notification channel id */
  c: string;
  /** session id */
  s: string;
  /** ask id */
  a: string;
  d: "allow" | "deny" | "approve" | "reject";
}

/** Slack mrkdwn treats &, < and > as markup; everything reported is plain text. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sessionLink(sessionId?: string): string {
  return sessionId ? `${config.publicUrl}/app/sessions/${encodeURIComponent(sessionId)}` : `${config.publicUrl}/app`;
}

/** Where "Open in Tessera" goes: the notification's own page when it has one (a digest, a spend alert), else its session. */
export function linkFor(n: { sessionId?: string; path?: string }): string {
  return n.path ? `${config.publicUrl}${n.path}` : sessionLink(n.sessionId);
}

function plain(text: string, max = 150) {
  return { type: "plain_text" as const, text: text.slice(0, max) || " ", emoji: false };
}

function baseBlocks(n: Notification): unknown[] {
  const fields = Object.entries(n.fields ?? {}).map(([k, v]) => ({ type: "mrkdwn", text: `*${esc(k)}*\n${esc(v)}` }));
  return [
    { type: "header", text: plain(n.title) },
    { type: "section", text: { type: "mrkdwn", text: esc(n.text).slice(0, 2900) || " " } },
    ...(fields.length ? [{ type: "section", fields: fields.slice(0, 10) }] : []),
  ];
}

/** Message for an incoming webhook: no interactivity, just a link back. */
export function webhookMessage(n: Notification): unknown {
  return {
    text: `${n.title} — ${n.text}`.slice(0, 3000),
    blocks: [...baseBlocks(n), { type: "actions", elements: [{ type: "button", text: plain("Open in Tessera"), url: linkFor(n) }] }],
  };
}

/**
 * Message for the Slack app. A session waiting on a permission prompt or a plan
 * gets buttons that answer it; everything else gets a link.
 */
export function appMessage(n: Notification, channelId: string): { text: string; blocks: unknown[] } {
  const actions: unknown[] = [];
  if (n.ask && n.sessionId && (n.ask.kind === "permission" || n.ask.kind === "plan")) {
    const v = (d: ActionValue["d"]) => JSON.stringify({ c: channelId, s: n.sessionId!, a: n.ask!.id, d } satisfies ActionValue);
    if (n.ask.kind === "permission") {
      actions.push({ type: "button", action_id: "tessera_answer_allow", style: "primary", text: plain("Allow"), value: v("allow") });
      actions.push({ type: "button", action_id: "tessera_answer_deny", style: "danger", text: plain("Deny"), value: v("deny") });
    } else {
      actions.push({ type: "button", action_id: "tessera_answer_approve", style: "primary", text: plain("Approve plan"), value: v("approve") });
      actions.push({ type: "button", action_id: "tessera_sendback", text: plain("Send back…"), value: v("reject") });
    }
  }
  actions.push({ type: "button", action_id: "tessera_open", text: plain("Open in Tessera"), url: linkFor(n) });
  const blocks = [...baseBlocks(n), { type: "actions", block_id: "tessera_actions", elements: actions }];
  if (actions.length > 1) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Answering here is recorded in Tessera's audit log under your name." }] });
  return { text: `${n.title} — ${n.text}`.slice(0, 3000), blocks };
}

/** The same message once the prompt is closed: no buttons, and who closed it. */
export function resolvedMessage(n: Pick<Notification, "title" | "text" | "fields" | "sessionId">, outcome: string): { text: string; blocks: unknown[] } {
  return {
    text: `${n.title} — ${outcome}`.slice(0, 3000),
    blocks: [
      ...baseBlocks({ ...n, event: "session.waiting", dedupeKey: "" }),
      { type: "context", elements: [{ type: "mrkdwn", text: esc(outcome) }] },
      { type: "actions", elements: [{ type: "button", action_id: "tessera_open", text: plain("Open in Tessera"), url: linkFor(n) }] },
    ],
  };
}

/** Modal that asks for the feedback to send with a rejected plan. */
export function sendBackModal(value: ActionValue, message: { channel: string; ts: string }): unknown {
  return {
    type: "modal",
    callback_id: "tessera_sendback_submit",
    private_metadata: JSON.stringify({ ...value, ch: message.channel, ts: message.ts }),
    title: plain("Send the plan back", 24),
    submit: plain("Send back", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: "feedback",
        label: plain("What should change?"),
        element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 3000, placeholder: plain("Split the migration into two steps and keep the old column until the backfill is done.") },
      },
    ],
  };
}

export class SlackError extends Error {}

/** Call a Slack Web API method with a bot token. */
export async function slackApi<T extends Record<string, unknown>>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.slackApiUrl}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T & { ok?: boolean; error?: string };
  if (!data.ok) throw new SlackError(`${method}: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

export async function slackUserEmail(token: string, userId: string): Promise<string | null> {
  const r = await slackApi<{ user?: { profile?: { email?: string }; deleted?: boolean; is_bot?: boolean } }>(token, "users.info", { user: userId });
  if (!r.user || r.user.deleted || r.user.is_bot) return null;
  return r.user.profile?.email?.toLowerCase() ?? null;
}

/**
 * Verify Slack's request signature: HMAC-SHA256 over "v0:<timestamp>:<raw body>"
 * with the app's signing secret, and a timestamp within five minutes so a
 * captured request cannot be replayed later.
 */
export function verifySlackSignature(signingSecret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** App manifest an owner pastes into api.slack.com → Create app → From a manifest. */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: { name: "Tessera", description: "Answer and approve your AI coding agents from Slack.", background_color: "#0b1416" },
    features: { bot_user: { display_name: "Tessera", always_online: false } },
    oauth_config: { scopes: { bot: ["chat:write", "users:read", "users:read.email"] } },
    settings: {
      interactivity: { is_enabled: true, request_url: `${config.publicUrl}/api/integrations/slack/actions` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
