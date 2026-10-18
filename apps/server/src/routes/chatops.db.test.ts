/**
 * Notifications that act: the Slack app's buttons and modal, PagerDuty
 * incidents that open and resolve, signed webhooks, and channels that wait
 * before they notify. Slack, PagerDuty and the webhook receiver are one local
 * HTTP server that records what it is sent; the app runs on real PostgreSQL.
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ---- a fake Slack Web API, PagerDuty Events API and webhook receiver -------------
interface Call { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders; raw: string }
const calls: Call[] = [];
const slackEmails: Record<string, string> = {};
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* not json */
    }
    const path = new URL(req.url!, "http://x").pathname;
    calls.push({ path, body, headers: req.headers, raw });
    res.writeHead(200, { "content-type": "application/json" });
    if (path === "/slack/auth.test") return res.end(JSON.stringify({ ok: true, team: "Acme", user: "tessera" }));
    if (path === "/slack/chat.postMessage") return res.end(JSON.stringify({ ok: true, channel: body.channel, ts: `${Date.now()}.000100` }));
    if (path === "/slack/chat.update" || path === "/slack/views.open") return res.end(JSON.stringify({ ok: true }));
    if (path === "/slack/users.info") {
      const email = slackEmails[String(body.user)];
      return res.end(JSON.stringify(email ? { ok: true, user: { id: body.user, profile: { email } } } : { ok: false, error: "user_not_found" }));
    }
    return res.end(JSON.stringify({ ok: true, status: "success" }));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.SLACK_API_URL = `${FAKE}/slack`;
process.env.PAGERDUTY_EVENTS_URL = `${FAKE}/pagerduty`;
process.env.PUBLIC_URL = "http://localhost:4700";

const { pool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");
const { hashPassword } = await import("../auth/crypto.js");
const { issueDevice } = await import("../auth/devices.js");

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const H = { "content-type": "application/json", "x-tessera-client": "web" };
const SIGNING = "0123456789abcdef0123456789abcdef";
const until = async <T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const callsTo = (path: string) => calls.filter((c) => c.path === path);

function signed(payload: unknown, opts: { secret?: string; ts?: number } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { body, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig } };
}

describe.skipIf(!reachable)("acting from chat", () => {
  let app: FastifyInstance;
  let fleet: import("../fleet/fleet.js").Fleet;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  const ownerEmail = `owner-${sfx}@chatops.test`;
  const viewerEmail = `viewer-${sfx}@chatops.test`;
  let cookie = "";
  let token = "";
  let slackChannel = "";
  const sessionId = `s-${sfx}`;

  const report = (openAsk: Record<string, unknown> | null, status: "running" | "waiting" = openAsk ? "waiting" : "running") => ({
    v: 1,
    sentAt: new Date().toISOString(),
    reporter: { kind: "custom", version: "0.1.0" },
    machine: { hostname: "dev-laptop", machineId: "m-1" },
    session: {
      id: sessionId, name: "Refactor billing", status, startedAt: new Date(Date.now() - 60_000).toISOString(),
      waitReason: openAsk ? (openAsk.kind === "plan" ? "plan" : "permission") : null,
      openAsk: openAsk ? { createdAt: new Date().toISOString(), options: [], ...openAsk } : null,
    },
    events: [],
  });
  const ingest = (r: unknown) => app.inject({ method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: r as object });

  const press = (askId: string, d: string, user = "U-OWNER", actionId = `tessera_answer_${d}`) =>
    signed({
      type: "block_actions",
      user: { id: user, team_id: "T1" },
      team: { id: "T1" },
      trigger_id: "trig-1",
      response_url: `${FAKE}/response`,
      container: { channel_id: "C0CHATOPS", message_ts: "1.1" },
      actions: [{ action_id: actionId, value: JSON.stringify({ c: slackChannel, s: sessionId, a: askId, d }) }],
    });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    const built = await buildApp();
    app = built.server;
    fleet = built.fleet;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'ChatOps Co', $2)", [orgId, `chatops-${sfx}`]);
    const owner = await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, 'Owner Person', 'owner', $3) RETURNING id", [orgId, ownerEmail, await hashPassword("owner-password-123")]);
    await pool.query("INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, 'Viewer Person', 'viewer')", [orgId, viewerEmail]);
    slackEmails["U-OWNER"] = ownerEmail;
    slackEmails["U-VIEWER"] = viewerEmail;
    slackEmails["U-STRANGER"] = `nobody-${sfx}@elsewhere.test`;
    token = (await issueDevice(orgId, owner.rows[0]!.id, "laptop")).token;
    const r = await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: ownerEmail, password: "owner-password-123" } });
    cookie = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;
  });

  afterAll(async () => {
    await fleet.stop();
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
    fake.close();
  });

  it("checks the bot token when a Slack app channel is added", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/admin/channels", headers: { ...H, cookie }, payload: { kind: "slack_app", name: "#agents", botToken: "not-a-token", signingSecret: SIGNING, channel: "C0CHATOPS" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/admin/channels", headers: { ...H, cookie }, payload: { kind: "slack_app", name: "#agents", botToken: "xoxb-1111-2222-abcdefabcdef", signingSecret: SIGNING, channel: "C0CHATOPS", events: ["session.waiting"] } });
    expect(ok.statusCode).toBe(200);
    slackChannel = ok.json().id;
    expect(callsTo("/slack/auth.test").at(-1)?.headers.authorization).toBe("Bearer xoxb-1111-2222-abcdefabcdef");
    const list = await app.inject({ method: "GET", url: "/api/admin/channels", headers: { cookie } });
    const ch = list.json().channels.find((c: { id: string }) => c.id === slackChannel);
    expect(ch.slackChannel).toBe("C0CHATOPS");
    expect(JSON.stringify(list.json())).not.toContain("xoxb-");
    expect(list.json().slack.manifest.settings.interactivity.request_url).toBe("http://localhost:4700/api/integrations/slack/actions");
  });

  it("posts a waiting permission prompt with Allow and Deny, and answers it from the button", async () => {
    expect((await ingest(report({ id: "ask-1", kind: "permission", tool: "Bash", prompt: "Bash(rm -rf build/)" }))).statusCode).toBe(200);
    const post = await until(() => callsTo("/slack/chat.postMessage").find((c) => JSON.stringify(c.body).includes("ask-1")));
    expect(post.body.channel).toBe("C0CHATOPS");
    const actions = (post.body.blocks as { type: string; elements?: { action_id?: string; value?: string }[] }[]).find((b) => b.type === "actions")!.elements!;
    expect(actions.map((a) => a.action_id)).toEqual(["tessera_answer_allow", "tessera_answer_deny", "tessera_open"]);
    expect(JSON.parse(actions[0]!.value!)).toEqual({ c: slackChannel, s: sessionId, a: "ask-1", d: "allow" });

    const { body, headers } = press("ask-1", "allow");
    const res = await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers, payload: body });
    expect(res.statusCode).toBe(200);
    const d = await pool.query("SELECT kind, ask_id, payload FROM deliveries WHERE org_id = $1 AND session_id = $2", [orgId, sessionId]);
    expect(d.rows).toEqual([{ kind: "answer", ask_id: "ask-1", payload: expect.objectContaining({ decision: "allow", by: "Owner Person", via: "slack" }) }]);
    const a = await pool.query("SELECT action, actor_name, detail FROM audit_log WHERE org_id = $1 AND action LIKE 'session.answer%'", [orgId]);
    expect(a.rows[0]).toMatchObject({ action: "session.answer.allow", actor_name: "Owner Person", detail: { via: "slack", askId: "ask-1" } });
    // The message loses its buttons and says who answered.
    const upd = callsTo("/slack/chat.update").at(-1)!;
    expect(JSON.stringify(upd.body)).toContain("Allowed by Owner Person from Slack");
    expect(JSON.stringify(upd.body)).not.toContain("tessera_answer_allow");
    const link = await pool.query("SELECT slack_user FROM slack_user_links WHERE org_id = $1", [orgId]);
    expect(link.rows).toEqual([{ slack_user: "U-OWNER" }]);
  });

  it("refuses requests without a valid, fresh Slack signature", async () => {
    await ingest(report({ id: "ask-2", kind: "permission", tool: "Write", prompt: "Write(.env)" }));
    const forged = press("ask-2", "allow");
    const wrongSecret = signed(JSON.parse(new URLSearchParams(forged.body).get("payload")!), { secret: "f".repeat(32) });
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: wrongSecret.headers, payload: wrongSecret.body })).statusCode).toBe(401);
    const old = signed(JSON.parse(new URLSearchParams(forged.body).get("payload")!), { ts: Math.floor(Date.now() / 1000) - 600 });
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: old.headers, payload: old.body })).statusCode).toBe(401);
    const tampered = { ...forged, body: forged.body.replace("allow", "deny") };
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: tampered.headers, payload: tampered.body })).statusCode).toBe(401);
    const d = await pool.query("SELECT 1 FROM deliveries WHERE org_id = $1 AND ask_id = 'ask-2'", [orgId]);
    expect(d.rowCount).toBe(0);
  });

  it("tells people it cannot match, or who may not act, without answering", async () => {
    const before = calls.length;
    const stranger = press("ask-2", "allow", "U-STRANGER");
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: stranger.headers, payload: stranger.body })).statusCode).toBe(200);
    const viewer = press("ask-2", "allow", "U-VIEWER");
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: viewer.headers, payload: viewer.body })).statusCode).toBe(200);
    const replies = calls.slice(before).filter((c) => c.path === "/response");
    expect(replies.map((r) => r.body.response_type)).toEqual(["ephemeral", "ephemeral"]);
    expect(String(replies[0]!.body.text)).toContain("does not know you");
    expect(String(replies[1]!.body.text)).toContain("cannot act on this session");
    const d = await pool.query("SELECT 1 FROM deliveries WHERE org_id = $1 AND ask_id = 'ask-2'", [orgId]);
    expect(d.rowCount).toBe(0);
  });

  it("sends a plan back with the feedback typed into the modal", async () => {
    await ingest(report({ id: "ask-3", kind: "plan", tool: "ExitPlanMode", prompt: "1. Add the column\n2. Backfill\n3. Drop the old column" }));
    const post = await until(() => callsTo("/slack/chat.postMessage").find((c) => JSON.stringify(c.body).includes("ask-3")));
    expect(JSON.stringify(post.body)).toContain("tessera_sendback");
    const open = press("ask-3", "reject", "U-OWNER", "tessera_sendback");
    await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: open.headers, payload: open.body });
    const view = callsTo("/slack/views.open").at(-1)!;
    const meta = (view.body.view as { private_metadata: string }).private_metadata;

    const submit = (text: string) =>
      signed({ type: "view_submission", user: { id: "U-OWNER", team_id: "T1" }, view: { callback_id: "tessera_sendback_submit", private_metadata: meta, state: { values: { feedback: { text: { value: text } } } } } });
    const empty = submit("  ");
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: empty.headers, payload: empty.body })).json().response_action).toBe("errors");
    const ok = submit("Keep the old column until the backfill is verified.");
    expect((await app.inject({ method: "POST", url: "/api/integrations/slack/actions", headers: ok.headers, payload: ok.body })).json()).toEqual({ response_action: "clear" });
    const d = await pool.query("SELECT payload FROM deliveries WHERE org_id = $1 AND ask_id = 'ask-3'", [orgId]);
    expect(d.rows[0]!.payload).toMatchObject({ decision: "reject", text: "Keep the old column until the backfill is verified.", via: "slack" });
  });

  it("opens a PagerDuty incident while a session waits and resolves it when it moves on", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/channels", headers: { ...H, cookie }, payload: { kind: "pagerduty", name: "Agents on-call", routingKey: "R".repeat(32), events: ["session.waiting"] } });
    expect(r.statusCode).toBe(200);
    await ingest(report({ id: "ask-4", kind: "permission", tool: "Bash", prompt: "Bash(terraform apply)" }));
    const trigger = await until(() => callsTo("/pagerduty").find((c) => c.body.event_action === "trigger" && String(c.body.dedup_key).endsWith(":ask-4")));
    expect(trigger.body).toMatchObject({ routing_key: "R".repeat(32), payload: { severity: "warning", class: "session.waiting" } });
    await ingest(report(null));
    const resolve = await until(() => callsTo("/pagerduty").find((c) => c.body.event_action === "resolve" && c.body.dedup_key === trigger.body.dedup_key));
    expect(resolve).toBeTruthy();
  });

  it("signs plain webhooks with the secret shown once at creation", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/channels", headers: { ...H, cookie }, payload: { kind: "webhook", name: "Ops bus", url: `${FAKE}/hook`, events: ["session.waiting"] } });
    const secret = r.json().signingSecret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await ingest(report({ id: "ask-5", kind: "permission", tool: "Bash", prompt: "Bash(npm publish)" }));
    const hook = await until(() => callsTo("/hook").find((c) => c.raw.includes("ask-5")));
    const [t, v1] = String(hook.headers["x-tessera-signature"]).split(",").map((x) => x.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", secret).update(`${t}.${hook.raw}`).digest("hex"));
    expect(hook.headers["x-tessera-event"]).toBe("session.waiting");
    const list = await app.inject({ method: "GET", url: "/api/admin/channels", headers: { cookie } });
    expect(JSON.stringify(list.json())).not.toContain(secret);
  });

  it("holds an escalation channel until the session has waited long enough", async () => {
    await ingest(report(null));
    const r = await app.inject({ method: "POST", url: "/api/admin/channels", headers: { ...H, cookie }, payload: { kind: "teams_webhook", name: "Leads", url: `${FAKE}/teams`, events: ["session.waiting"], delaySeconds: 2 } });
    expect(r.statusCode).toBe(200);
    await fleet.start();
    const t0 = Date.now();
    await ingest(report({ id: "ask-6", kind: "permission", tool: "Bash", prompt: "Bash(kubectl delete ns staging)" }));
    await new Promise((res) => setTimeout(res, 800));
    expect(callsTo("/teams")).toHaveLength(0);
    const card = await until(() => callsTo("/teams")[0], 5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(JSON.stringify(card.body)).toContain("AdaptiveCard");
    await new Promise((res) => setTimeout(res, 1200));
    expect(callsTo("/teams")).toHaveLength(1);
  });
});
