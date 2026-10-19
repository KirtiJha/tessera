import type { Presence } from "@tessera/contract";
import webpush from "web-push";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

/**
 * What one person wants: how long their prompts wait for Tessera before the
 * terminal asks (presence), and which personal notifications they get. And
 * the Web Push plumbing that delivers those notifications to their browsers
 * and installed apps.
 */

export interface NotifyPrefs {
  /** A prompt or question is waiting on them. */
  waiting: boolean;
  /** A turn that ran for a while has finished. */
  done: boolean;
  /** An agent or the session failed. */
  failed: boolean;
}
export const DEFAULT_NOTIFY: NotifyPrefs = { waiting: true, done: true, failed: true };

export interface PersonalPrefs {
  presence: Presence;
  notify: NotifyPrefs;
}

// Presence decides how long a reporter waits, so a change must reach it within seconds.
const cache = new Map<string, { at: number; prefs: PersonalPrefs }>();
const TTL_MS = 5_000;

export function forgetPrefs(userId: string): void {
  cache.delete(userId);
}

export async function prefsFor(userId: string | null | undefined): Promise<PersonalPrefs> {
  if (!userId) return { presence: "auto", notify: DEFAULT_NOTIFY };
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.prefs;
  const r = await pool.query<{ presence: Presence; notify: Partial<NotifyPrefs> }>("SELECT presence, notify FROM users WHERE id = $1", [userId]);
  const row = r.rows[0];
  const prefs: PersonalPrefs = { presence: row?.presence ?? "auto", notify: { ...DEFAULT_NOTIFY, ...(row?.notify ?? {}) } };
  cache.set(userId, { at: Date.now(), prefs });
  return prefs;
}

export async function savePrefs(userId: string, change: { presence?: Presence; notify?: Partial<NotifyPrefs> }): Promise<PersonalPrefs> {
  const current = await prefsFor(userId);
  const next: PersonalPrefs = { presence: change.presence ?? current.presence, notify: { ...current.notify, ...(change.notify ?? {}) } };
  await pool.query("UPDATE users SET presence = $2, notify = $3 WHERE id = $1", [userId, next.presence, JSON.stringify(next.notify)]);
  cache.set(userId, { at: Date.now(), prefs: next });
  return next;
}

// ---- Web Push ---------------------------------------------------------------

let vapid: { publicKey: string; privateKey: string } | null = null;

/** The server's VAPID key pair, made once and shared by every replica through the database. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (vapid) return vapid;
  const read = async () => {
    const r = await pool.query<{ name: string; value: string }>("SELECT name, value FROM server_keys WHERE name IN ('vapid_public', 'vapid_private')");
    const m = new Map(r.rows.map((x) => [x.name, x.value]));
    return m.get("vapid_public") && m.get("vapid_private") ? { publicKey: m.get("vapid_public")!, privateKey: m.get("vapid_private")! } : null;
  };
  let keys = await read();
  if (!keys) {
    const made = webpush.generateVAPIDKeys();
    // Two replicas starting together: the first insert wins and both read it back.
    await pool.query("INSERT INTO server_keys (name, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (name) DO NOTHING", [made.publicKey, made.privateKey]);
    keys = await read();
  }
  vapid = keys!;
  return vapid;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function subscribe(userId: string, sub: PushSubscriptionInput, label: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, label = EXCLUDED.label, failures = 0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, label],
  );
}

export async function unsubscribe(userId: string, endpoint: string): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [userId, endpoint]);
}

export async function subscriptionCount(userId: string): Promise<number> {
  const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [userId]);
  return r.rows[0]?.n ?? 0;
}

/** What a notification carries to the service worker, which decides how to show it. */
export interface PushPayload {
  kind: "waiting" | "done" | "failed" | "test";
  title: string;
  body: string;
  /** Same tag replaces the earlier notification on the device instead of stacking. */
  tag: string;
  url: string;
  sessionId?: string;
  /** For a permission prompt or plan answerable right now: the service worker offers Allow and Deny. */
  ask?: { id: string; kind: "permission" | "plan" | "question" };
}

/** Send to every device a person has subscribed. Dead subscriptions are removed; the rest is best effort. */
export async function pushTo(userIds: (string | null | undefined)[], payload: PushPayload, log?: { warn: (o: object, m: string) => void }): Promise<number> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return 0;
  const r = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)", [ids]);
  if (!r.rows.length) return 0;
  const keys = await vapidKeys();
  const subject = config.publicUrl.startsWith("https://") ? config.publicUrl : "mailto:admin@tessera.invalid";
  let sent = 0;
  await Promise.all(
    r.rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: payload.kind === "waiting" ? 600 : 3600,
          urgency: payload.kind === "waiting" ? "high" : "normal",
          timeout: 8000,
        });
        sent++;
        await pool.query("UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1", [s.id]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404 and 410: the browser dropped this subscription for good.
        if (status === 404 || status === 410) await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [s.id]);
        else {
          await pool.query("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1", [s.id]);
          await pool.query("DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 20", [s.id]);
          log?.warn({ err: (e as Error).message, status }, "push failed");
        }
      }
    }),
  );
  return sent;
}
