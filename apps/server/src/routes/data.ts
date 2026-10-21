import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { forgetApiKeys } from "../auth/apikeys.js";
import { forgetDevice } from "../auth/devices.js";
import { decrypt, encrypt } from "../auth/crypto.js";
import { canManageOrg } from "../auth/rbac.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { body as streamBody, entryOut, send, type AuditRow, type StreamFormat } from "../compliance/stream.js";
import { config } from "../config.js";
import { pool, withTx } from "../db/pool.js";
import { dataSettingsFor, DataSettingsSchema, saveDataSettings } from "../fleet/datasettings.js";
import type { Fleet } from "../fleet/fleet.js";
import { toCsv } from "./analytics.js";

const https = z.string().url().max(1000).refine((u) => u.startsWith("https://") || (!config.isProd && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)), "must use https");

/** Data handling: retention, legal hold, data-loss prevention, audit export and streaming, a person's export and erasure. */
export async function dataRoutes(app: FastifyInstance, opts: { fleet: Fleet }): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });
  const admin = (req: FastifyRequest) => {
    const p = req.principal!;
    if (!canManageOrg(p)) throw Object.assign(new Error("admin role required"), { statusCode: 403 });
    return p;
  };
  const owner = (req: FastifyRequest) => {
    const p = req.principal!;
    if (p.role !== "owner") throw Object.assign(new Error("Only an owner can change how Tessera keeps data."), { statusCode: 403 });
    return p;
  };

  app.get("/", async (req) => {
    const p = admin(req);
    const [s, counts, stream] = await Promise.all([
      dataSettingsFor(p.orgId),
      pool.query<{ sessions: number; events: number; audit: number; oldest: string | null }>(
        `SELECT (SELECT COUNT(*)::int FROM sessions WHERE org_id = $1) AS sessions,
                (SELECT COUNT(*)::int FROM events WHERE org_id = $1) AS events,
                (SELECT COUNT(*)::int FROM audit_log WHERE org_id = $1) AS audit,
                (SELECT MIN(started_at) FROM sessions WHERE org_id = $1) AS oldest`,
        [p.orgId],
      ),
      pool.query<{ url_enc: string; header_name: string | null; format: string; enabled: boolean; cursor: string; last_sent_at: string | null; last_error: string | null }>("SELECT url_enc, header_name, format, enabled, cursor, last_sent_at, last_error FROM audit_streams WHERE org_id = $1", [p.orgId]),
    ]);
    const st = stream.rows[0];
    const pending = st ? (await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id = $1 AND id > $2", [p.orgId, st.cursor])).rows[0]!.n : 0;
    return {
      canEdit: p.role === "owner",
      settings: s,
      defaults: { retainSamplesDays: config.retainSamplesDays, retainEventsDays: config.retainEventsDays, retainSessionsDays: config.retainSessionsDays },
      /** Whether this server has a Claude API key, without which "explain this failure" cannot be turned on. */
      explainAvailable: !!config.anthropicApiKey,
      stored: counts.rows[0],
      // The URL can carry a secret (a signed query string, user:pass@); only its host leaves the server.
      stream: st ? { host: new URL(decrypt(st.url_enc)).host, headerName: st.header_name, format: st.format, enabled: st.enabled, lastSentAt: st.last_sent_at, lastError: st.last_error, pending } : null,
    };
  });

  app.put("/settings", async (req) => {
    const p = owner(req);
    const cur = await dataSettingsFor(p.orgId);
    const body = DataSettingsSchema.omit({ legalHold: true }).parse(req.body);
    const next = { ...body, legalHold: cur.legalHold };
    await saveDataSettings(p.orgId, next);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "data.settings", detail: { excerpts: next.excerpts, explainFailures: next.explainFailures, toolOutput: next.toolOutput, editHistory: next.editHistory, dlp: { ...next.dlp, terms: next.dlp.terms.length }, retainSamplesDays: next.retainSamplesDays, retainEventsDays: next.retainEventsDays, retainSessionsDays: next.retainSessionsDays }, ip: req.ip });
    return { ok: true };
  });

  app.post("/legal-hold", async (req, reply) => {
    const p = owner(req);
    const body = z.object({ on: z.boolean(), reason: z.string().trim().max(300).default("") }).parse(req.body);
    if (body.on && !body.reason) return reply.code(400).send({ error: "Say why the data is held (a matter or ticket reference), so it can be released when that ends." });
    const cur = await dataSettingsFor(p.orgId);
    await saveDataSettings(p.orgId, { ...cur, legalHold: body.on ? { reason: body.reason, by: p.name, since: new Date().toISOString() } : null });
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: body.on ? "data.hold.on" : "data.hold.off", detail: { reason: body.reason || (cur.legalHold?.reason ?? null) }, ip: req.ip });
    return { ok: true };
  });

  // ---- audit export and streaming ---------------------------------------------
  app.get("/audit/export", async (req, reply: FastifyReply) => {
    const p = admin(req);
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), format: z.enum(["jsonl", "csv"]).default("jsonl") }).parse(req.query);
    const params: unknown[] = [p.orgId];
    let where = "org_id = $1";
    if (q.from) where += ` AND created_at >= $${params.push(q.from)}::date`;
    if (q.to) where += ` AND created_at < ($${params.push(q.to)}::date + 1)`;
    const r = await pool.query<AuditRow>(`SELECT * FROM audit_log WHERE ${where} ORDER BY id ASC LIMIT 200000`, params);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "audit.export", detail: { from: q.from ?? null, to: q.to ?? null, format: q.format, entries: r.rowCount }, ip: req.ip });
    const name = `tessera-audit${q.from ? `-${q.from}` : ""}${q.to ? `-to-${q.to}` : ""}.${q.format}`;
    reply.header("content-disposition", `attachment; filename="${name}"`);
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8");
      return toCsv([["id", "time", "actor", "action", "target_type", "target_id", "detail", "ip", "prev_hash", "hash"], ...r.rows.map((e) => { const o = entryOut(e); return [o.id, o.time, o.actor, o.action, o.targetType, o.targetId, JSON.stringify(o.detail), o.ip, o.prevHash, o.hash]; })]);
    }
    reply.header("content-type", "application/x-ndjson; charset=utf-8");
    return streamBody("ndjson", r.rows).body;
  });

  const Stream = z.object({
    /** Leave out to keep the saved URL. */
    url: https.optional(),
    format: z.enum(["ndjson", "splunk_hec", "json_array"]),
    headerName: z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/, "a header name").nullable().default(null),
    headerValue: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().default(true),
    fromStart: z.boolean().default(false),
  });

  app.put("/audit/stream", async (req, reply) => {
    const p = owner(req);
    const b = Stream.parse(req.body);
    const cur = await pool.query<{ header_value_enc: string | null; url_enc: string }>("SELECT header_value_enc, url_enc FROM audit_streams WHERE org_id = $1", [p.orgId]);
    const urlEnc = b.url ? encrypt(b.url) : cur.rows[0]?.url_enc;
    if (!urlEnc) return reply.code(400).send({ error: "Give the destination URL." });
    const headerValueEnc = b.headerValue ? encrypt(b.headerValue) : b.headerName ? (cur.rows[0]?.header_value_enc ?? null) : null;
    if (b.headerName && !headerValueEnc) return reply.code(400).send({ error: "Give the header's value (for Splunk: Splunk <HEC token>; Datadog: your API key)." });
    // A new stream starts at the next entry, or replays the whole log when asked.
    const start = b.fromStart ? 0 : Number((await pool.query<{ m: string | null }>("SELECT MAX(id) AS m FROM audit_log WHERE org_id = $1", [p.orgId])).rows[0]?.m ?? 0);
    await pool.query(
      `INSERT INTO audit_streams (org_id, url_enc, header_name, header_value_enc, format, enabled, cursor) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id) DO UPDATE SET url_enc = EXCLUDED.url_enc, header_name = EXCLUDED.header_name, header_value_enc = EXCLUDED.header_value_enc,
         format = EXCLUDED.format, enabled = EXCLUDED.enabled, updated_at = now(), last_error = NULL ${b.fromStart ? ", cursor = 0" : ""}`,
      [p.orgId, urlEnc, b.headerName, headerValueEnc, b.format, b.enabled, start],
    );
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "audit.stream.update", detail: { host: new URL(decrypt(urlEnc)).host, format: b.format, enabled: b.enabled, fromStart: b.fromStart }, ip: req.ip });
    return { ok: true };
  });

  app.post("/audit/stream/test", async (req, reply) => {
    const p = owner(req);
    const s = (await pool.query<{ url_enc: string; header_name: string | null; header_value_enc: string | null; format: StreamFormat }>("SELECT url_enc, header_name, header_value_enc, format FROM audit_streams WHERE org_id = $1", [p.orgId])).rows[0];
    if (!s) return reply.code(404).send({ error: "Save a destination first." });
    const sample: AuditRow = { id: "0", org_id: p.orgId, actor_id: p.userId, actor_name: p.name, action: "audit.stream.test", target_type: null, target_id: null, detail: { note: "Test entry from Tessera. Not part of the audit log." }, ip: null, created_at: new Date().toISOString(), prev_hash: null, hash: "test" };
    try {
      await send(decrypt(s.url_enc), s.format, s.header_name && s.header_value_enc ? { name: s.header_name, value: decrypt(s.header_value_enc) } : null, [sample]);
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.delete("/audit/stream", async (req) => {
    const p = owner(req);
    await pool.query("DELETE FROM audit_streams WHERE org_id = $1", [p.orgId]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "audit.stream.delete", ip: req.ip });
    return { ok: true };
  });

  // ---- a person's data ----------------------------------------------------------
  /** Subject access: everything Tessera holds about one person, as JSON. */
  app.get("/people/:id/export", async (req, reply: FastifyReply) => {
    const p = admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = await pool.query("SELECT id, email, name, given_name, family_name, role, status, created_at, last_login_at, sso_issuer, sso_subject, erased_at FROM users WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    if (!u.rows[0]) return reply.code(404).send({ error: "no such person" });
    const [devices, keys, sessions, answered, decisions, actions] = await Promise.all([
      pool.query("SELECT id, label, hostname, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = $1", [id]),
      pool.query("SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1", [id]),
      pool.query("SELECT id, name, cwd, model, status, started_at, ended_at, git, tags, tokens FROM sessions WHERE org_id = $1 AND owner_id = $2 ORDER BY started_at", [p.orgId, id]),
      pool.query("SELECT session_id, id, kind, tool, prompt, created_at, closed_at, answer FROM asks WHERE org_id = $1 AND answered_by = $2 ORDER BY created_at", [p.orgId, id]),
      pool.query("SELECT session_id, tool, summary, rule_name, effect, enforced, created_at FROM policy_decisions WHERE org_id = $1 AND user_id = $2 ORDER BY created_at", [p.orgId, id]),
      pool.query("SELECT id, action, target_type, target_id, detail, created_at FROM audit_log WHERE org_id = $1 AND actor_id = $2 ORDER BY id", [p.orgId, id]),
    ]);
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.export", targetType: "user", targetId: id, detail: { sessions: sessions.rowCount }, ip: req.ip });
    reply.header("content-disposition", `attachment; filename="tessera-person-${id}.json"`);
    return { exportedAt: new Date().toISOString(), person: u.rows[0], devices: devices.rows, apiKeys: keys.rows, sessions: sessions.rows, promptsAnswered: answered.rows, policyDecisions: decisions.rows, actions: actions.rows };
  });

  /**
   * Erasure: delete a person's sessions and everything under them, their
   * devices, keys and links, and replace their name and email. The audit log
   * keeps its entries (its hash chain must verify, and it is the record of
   * what was done); the person's entry says they were erased.
   */
  app.post("/people/:id/erase", async (req, reply) => {
    const p = owner(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ confirm: z.string() }).parse(req.body);
    const s = await dataSettingsFor(p.orgId);
    if (s.legalHold) return reply.code(409).send({ error: `This organisation's data is under legal hold (${s.legalHold.reason}). Release the hold before erasing anyone.` });
    if (id === p.userId) return reply.code(400).send({ error: "You cannot erase yourself." });
    const u = (await pool.query<{ email: string; role: string; erased_at: string | null }>("SELECT email, role, erased_at FROM users WHERE id = $1 AND org_id = $2", [id, p.orgId])).rows[0];
    if (!u) return reply.code(404).send({ error: "no such person" });
    if (u.erased_at) return reply.code(409).send({ error: "This person was already erased." });
    if (u.role === "owner") return reply.code(400).send({ error: "Change their role from owner first." });
    if (body.confirm.trim().toLowerCase() !== u.email.toLowerCase()) return reply.code(400).send({ error: "Type the person's email address to confirm." });
    const counts = await withTx(async (c) => {
      const sessions = await c.query("DELETE FROM sessions WHERE org_id = $1 AND owner_id = $2", [p.orgId, id]);
      await c.query("DELETE FROM policy_decisions WHERE org_id = $1 AND user_id = $2", [p.orgId, id]);
      const devices = await c.query<{ token_hash: string }>("DELETE FROM devices WHERE user_id = $1 RETURNING token_hash", [id]);
      for (const d of devices.rows) forgetDevice(d.token_hash);
      await c.query("DELETE FROM api_keys WHERE user_id = $1", [id]);
      await c.query("DELETE FROM user_sessions WHERE user_id = $1", [id]);
      await c.query("DELETE FROM slack_user_links WHERE user_id = $1", [id]);
      await c.query(
        `UPDATE users SET name = 'Erased person', email = 'erased-' || id::text || '@erased.invalid', given_name = NULL, family_name = NULL,
                password_hash = NULL, invite_token_hash = NULL, sso_issuer = NULL, sso_subject = NULL, scim_external_id = NULL,
                status = 'disabled', team_id = NULL, erased_at = now() WHERE id = $1`,
        [id],
      );
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.erase", targetType: "user", targetId: id, detail: { sessions: sessions.rowCount, devices: devices.rowCount }, ip: req.ip }, c);
      return { sessions: sessions.rowCount ?? 0, devices: devices.rowCount ?? 0 };
    });
    forgetApiKeys();
    opts.fleet.forgetOwner(p.orgId, id);
    return { ok: true, ...counts };
  });
}
