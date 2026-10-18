import type { FastifyInstance, FastifyReply } from "fastify";
import type { Principal, Role } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { answerAsk, type Decision } from "../fleet/actions.js";
import type { Fleet } from "../fleet/fleet.js";
import { secretsOf } from "../notify/notifier.js";
import { esc, sendBackModal, slackApi, slackUserEmail, verifySlackSignature, type ActionValue } from "../notify/slack.js";

interface SlackPayload {
  type: "block_actions" | "view_submission" | string;
  user?: { id: string; team_id?: string };
  team?: { id: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts: string };
  actions?: { action_id: string; value?: string }[];
  view?: { callback_id: string; private_metadata: string; state: { values: Record<string, Record<string, { value?: string | null }>> } };
}

function parseValue(raw: string | undefined): ActionValue | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ActionValue>;
    if (typeof v.c === "string" && typeof v.s === "string" && typeof v.a === "string" && ["allow", "deny", "approve", "reject"].includes(v.d ?? "")) return v as ActionValue;
  } catch {
    /* not ours */
  }
  return null;
}

async function respond(responseUrl: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (!responseUrl?.startsWith("https://") && !responseUrl?.startsWith("http://127.0.0.1")) return;
  await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/**
 * Slack interactivity: the buttons on Tessera's Slack messages. Every request
 * is verified against the channel's signing secret before anything in it is
 * trusted; the Slack user is matched to a Tessera user by the email Slack
 * holds for them, and then the same rules as the console apply.
 */
export async function integrationRoutes(app: FastifyInstance, opts: { fleet: Fleet }): Promise<void> {
  const { fleet } = opts;

  // Slack signs the exact bytes it sent, so this scope keeps the form body raw.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  async function principalFor(orgId: string, botToken: string, teamId: string, slackUser: string): Promise<Principal | null> {
    type Row = { id: string; org_id: string; team_id: string | null; role: Role; name: string; email: string };
    const linked = await pool.query<Row>(
      `SELECT u.id, u.org_id, u.team_id, u.role, u.name, u.email FROM slack_user_links l JOIN users u ON u.id = l.user_id
        WHERE l.org_id = $1 AND l.slack_team = $2 AND l.slack_user = $3 AND u.status = 'active'`,
      [orgId, teamId, slackUser],
    );
    let row = linked.rows[0];
    if (!row) {
      const email = await slackUserEmail(botToken, slackUser);
      if (!email) return null;
      const u = await pool.query<Row>("SELECT id, org_id, team_id, role, name, email FROM users WHERE org_id = $1 AND lower(email) = $2 AND status = 'active'", [orgId, email]);
      row = u.rows[0];
      if (!row) return null;
      await pool.query("INSERT INTO slack_user_links (org_id, slack_team, slack_user, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, slack_team, slack_user) DO UPDATE SET user_id = EXCLUDED.user_id", [orgId, teamId, slackUser, row.id]);
    }
    return { userId: row.id, orgId: row.org_id, teamId: row.team_id, role: row.role, name: row.name, email: row.email };
  }

  app.post("/slack/actions", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply: FastifyReply) => {
    const raw = typeof req.body === "string" ? req.body : "";
    let payload: SlackPayload;
    try {
      payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "") as SlackPayload;
    } catch {
      return reply.code(400).send({ error: "expected a Slack interaction payload" });
    }

    const value =
      payload.type === "block_actions" ? parseValue(payload.actions?.[0]?.value) : payload.type === "view_submission" ? parseValue(payload.view?.private_metadata) : null;
    // The "Open in Tessera" link button also posts here; there is nothing to do for it.
    if (!value) return reply.code(200).send();

    const ch = await pool.query<{ org_id: string; secret_enc: string | null }>("SELECT org_id, secret_enc FROM notification_channels WHERE id = $1 AND kind = 'slack_app' AND enabled", [value.c]);
    const channel = ch.rows[0];
    if (!channel) return reply.code(404).send({ error: "unknown channel" });
    const secrets = secretsOf(channel);
    if (!secrets.signingSecret || !secrets.botToken) return reply.code(404).send({ error: "channel is not configured" });
    if (!verifySlackSignature(secrets.signingSecret, req.headers["x-slack-request-timestamp"] as string | undefined, req.headers["x-slack-signature"] as string | undefined, raw)) {
      req.log.warn({ channel: value.c }, "slack request with a bad signature");
      return reply.code(401).send({ error: "bad signature" });
    }

    const orgId = channel.org_id;
    const teamId = payload.user?.team_id ?? payload.team?.id ?? "";
    const slackUser = payload.user?.id ?? "";
    let p: Principal | null = null;
    try {
      p = await principalFor(orgId, secrets.botToken, teamId, slackUser);
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, "slack user lookup failed");
    }

    if (payload.type === "block_actions") {
      const action = payload.actions![0]!;
      if (!p) {
        await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "Tessera does not know you: your Slack email does not match an active Tessera account in this organisation. Ask an admin to invite you, then try again." });
        return reply.code(200).send();
      }
      if (action.action_id === "tessera_sendback") {
        const msg = { channel: payload.container?.channel_id ?? payload.channel?.id ?? "", ts: payload.container?.message_ts ?? payload.message?.ts ?? "" };
        await slackApi(secrets.botToken, "views.open", { trigger_id: payload.trigger_id, view: sendBackModal(value, msg) }).catch((e) => req.log.warn({ err: (e as Error).message }, "slack views.open failed"));
        return reply.code(200).send();
      }
      try {
        await answerAsk(fleet, p, value.s, { askId: value.a, decision: value.d as Decision }, "slack", { ip: req.ip, log: req.log });
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: esc(err.statusCode ? err.message : "Tessera could not record that answer. Try again from the console.") });
      }
      return reply.code(200).send();
    }

    // view_submission: the feedback for a plan sent back.
    const text = payload.view?.state.values.feedback?.text?.value?.trim() ?? "";
    if (!text) return reply.send({ response_action: "errors", errors: { feedback: "Say what should change, so the agent can act on it." } });
    if (!p) return reply.send({ response_action: "errors", errors: { feedback: "Your Slack email does not match an active Tessera account in this organisation." } });
    try {
      await answerAsk(fleet, p, value.s, { askId: value.a, decision: "reject", text: text.slice(0, 3000) }, "slack", { ip: req.ip, log: req.log });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.send({ response_action: "errors", errors: { feedback: err.statusCode ? err.message : "Tessera could not record that answer." } });
    }
    return reply.send({ response_action: "clear" });
  });
}
