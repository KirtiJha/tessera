import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit.js";
import { decrypt, encrypt, newToken, sha256 } from "../auth/crypto.js";
import { txt } from "../auth/dnstxt.js";
import { forgetScimTokens } from "./scim.js";
import { authorizationUrl, discover, domainOf, finish, newFlow, OidcError, PUBLIC_DOMAINS, safeReturnTo, type FlowState } from "../auth/oidc.js";
import { checkMutation, createUserSession, requireUser, setSessionCookie } from "../auth/session.js";
import { config } from "../config.js";
import { pool, withTx } from "../db/pool.js";

const FLOW_COOKIE = "tessera_sso";
const FLOW_TTL_MS = 10 * 60 * 1000;

export const redirectUri = (): string => `${config.publicUrl}/api/auth/sso/callback`;

interface SsoRow {
  org_id: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  jit_provisioning: boolean;
  default_role: "admin" | "approver" | "operator" | "viewer";
  enforce: boolean;
}

async function ssoForOrg(orgId: string): Promise<SsoRow | null> {
  const r = await pool.query<SsoRow>("SELECT * FROM org_sso WHERE org_id = $1", [orgId]);
  return r.rows[0] ?? null;
}

async function orgForEmail(email: string): Promise<{ orgId: string; orgName: string } | null> {
  const r = await pool.query<{ org_id: string; name: string }>(
    "SELECT d.org_id, o.name FROM sso_domains d JOIN orgs o ON o.id = d.org_id JOIN org_sso s ON s.org_id = d.org_id WHERE d.domain = $1 AND d.verified_at IS NOT NULL AND s.enabled",
    [domainOf(email)],
  );
  return r.rows[0] ? { orgId: r.rows[0].org_id, orgName: r.rows[0].name } : null;
}

/** True when this user must sign in through SSO rather than with a password. */
export async function ssoEnforcedFor(orgId: string, role: string): Promise<boolean> {
  if (role === "owner") return false;
  const s = await ssoForOrg(orgId);
  return !!s && s.enabled && s.enforce;
}

function fail(reply: FastifyReply, message: string): FastifyReply {
  reply.clearCookie(FLOW_COOKIE, { path: "/api/auth/sso" });
  return reply.redirect(`/signin?sso_error=${encodeURIComponent(message)}`, 302);
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Public sign-in routes: discovery by email, the redirect to the provider, and the callback. */
export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/discover", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).parse(req.query);
    const org = await orgForEmail(email);
    if (!org) return { sso: false };
    const s = await ssoForOrg(org.orgId);
    return { sso: true, orgName: org.orgName, enforced: !!s?.enforce };
  });

  app.get("/start", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const q = z.object({ email: z.string().trim().toLowerCase().email().max(200), returnTo: z.string().max(300).optional() }).safeParse(req.query);
    if (!q.success) return fail(reply, "Enter your work email to sign in with SSO.");
    const org = await orgForEmail(q.data.email);
    if (!org) return fail(reply, "Single sign-on is not set up for that email domain.");
    const s = await ssoForOrg(org.orgId);
    if (!s?.enabled) return fail(reply, "Single sign-on is not set up for that email domain.");
    let d;
    try {
      d = await discover(s.issuer);
    } catch (e) {
      req.log.warn({ org: org.orgId, err: (e as Error).message }, "sso discovery failed");
      return fail(reply, "Your identity provider could not be reached. Try again, or ask your Tessera owner to check the SSO settings.");
    }
    const flow = newFlow(org.orgId, safeReturnTo(q.data.returnTo));
    // Lax, not Strict: the provider sends the browser back here with a cross-site redirect.
    reply.setCookie(FLOW_COOKIE, JSON.stringify(flow), { path: "/api/auth/sso", httpOnly: true, sameSite: "lax", secure: config.isProd, signed: true, maxAge: FLOW_TTL_MS / 1000 });
    return reply.redirect(authorizationUrl(d, s.client_id, redirectUri(), flow, q.data.email), 302);
  });

  app.get("/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return fail(reply, `Your identity provider did not sign you in: ${(q.error_description ?? q.error).slice(0, 200)}`);
    const raw = req.cookies[FLOW_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return fail(reply, "This sign-in link has expired. Start again.");
    let flow: FlowState;
    try {
      flow = JSON.parse(unsigned.value) as FlowState;
    } catch {
      return fail(reply, "This sign-in link has expired. Start again.");
    }
    if (!q.code || !q.state || !sameString(q.state, flow.state) || Date.now() - flow.createdAt > FLOW_TTL_MS) {
      return fail(reply, "This sign-in link has expired. Start again.");
    }
    reply.clearCookie(FLOW_COOKIE, { path: "/api/auth/sso" });

    const s = await ssoForOrg(flow.orgId);
    if (!s?.enabled) return fail(reply, "Single sign-on was turned off for your organisation.");
    let id;
    try {
      id = await finish(await discover(s.issuer), s.client_id, decrypt(s.client_secret_enc), redirectUri(), q.code, flow);
    } catch (e) {
      req.log.warn({ org: flow.orgId, err: (e as Error).message }, "sso callback failed");
      return fail(reply, e instanceof OidcError ? e.message : "Sign-in failed. Try again.");
    }

    const outcome = await resolveUser(flow.orgId, s, id);
    if ("error" in outcome) {
      req.log.info({ org: flow.orgId, email: id.email, reason: outcome.error }, "sso sign-in refused");
      return fail(reply, outcome.error);
    }
    await audit({
      orgId: flow.orgId,
      actorId: outcome.userId,
      actorName: outcome.name,
      action: outcome.created ? "user.provision.sso" : "user.signin.sso",
      targetType: "user",
      targetId: outcome.userId,
      detail: { issuer: id.issuer, email: id.email },
      ip: req.ip,
    });
    const token = await createUserSession(outcome.userId, req.ip, req.headers["user-agent"]);
    setSessionCookie(reply, token);
    return reply.redirect(flow.returnTo, 302);
  });
}

type Resolved = { userId: string; name: string; created: boolean } | { error: string };

/**
 * Who the provider's identity is in this organisation. A provider can only
 * sign in users of its own organisation, and once a user is bound to a
 * provider subject, only that subject signs them in.
 */
async function resolveUser(orgId: string, s: SsoRow, id: { issuer: string; subject: string; email: string; name: string | null }): Promise<Resolved> {
  return withTx(async (c) => {
    const bySub = await c.query<{ id: string; org_id: string; name: string; status: string }>(
      "SELECT id, org_id, name, status FROM users WHERE sso_issuer = $1 AND sso_subject = $2 FOR UPDATE",
      [id.issuer, id.subject],
    );
    let u = bySub.rows[0];
    if (!u) {
      const byEmail = await c.query<{ id: string; org_id: string; name: string; status: string; sso_subject: string | null; sso_issuer: string | null }>(
        "SELECT id, org_id, name, status, sso_subject, sso_issuer FROM users WHERE lower(email) = $1 FOR UPDATE",
        [id.email],
      );
      const e = byEmail.rows[0];
      if (e) {
        if (e.org_id !== orgId) return { error: "This email belongs to another Tessera organisation." };
        if (e.sso_subject && (e.sso_subject !== id.subject || e.sso_issuer !== id.issuer)) {
          return { error: "This account is linked to a different identity at your provider. Ask your Tessera owner to reset its SSO link." };
        }
        await c.query("UPDATE users SET sso_issuer = $2, sso_subject = $3 WHERE id = $1", [e.id, id.issuer, id.subject]);
        u = e;
      }
    }
    if (u) {
      if (u.org_id !== orgId) return { error: "This identity belongs to another Tessera organisation." };
      if (u.status === "disabled") return { error: "Your Tessera account is disabled. Ask an admin to enable it." };
      if (u.status === "invited") {
        await c.query("UPDATE users SET status = 'active', invite_token_hash = NULL, name = COALESCE($2, name) WHERE id = $1", [u.id, id.name]);
      }
      await c.query("UPDATE users SET last_login_at = now() WHERE id = $1", [u.id]);
      return { userId: u.id, name: id.name ?? u.name, created: false };
    }
    // New person: create them only when the organisation allows it and owns the email domain.
    if (!s.jit_provisioning) return { error: "You do not have a Tessera account yet. Ask an admin to invite you." };
    const owns = await c.query("SELECT 1 FROM sso_domains WHERE domain = $1 AND org_id = $2 AND verified_at IS NOT NULL", [domainOf(id.email), orgId]);
    if (!owns.rowCount) return { error: "Your email domain is not one this organisation signs in with." };
    const name = id.name ?? id.email.split("@")[0]!;
    const r = await c.query<{ id: string }>(
      "INSERT INTO users (org_id, email, name, role, status, sso_issuer, sso_subject, last_login_at) VALUES ($1,$2,$3,$4,'active',$5,$6,now()) RETURNING id",
      [orgId, id.email, name, s.default_role, id.issuer, id.subject],
    );
    return { userId: r.rows[0]!.id, name, created: true };
  });
}

// ---- owner settings ---------------------------------------------------------

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "not a valid domain");

function owner(req: FastifyRequest) {
  const p = req.principal!;
  if (p.role !== "owner") throw Object.assign(new Error("Only an owner can change single sign-on."), { statusCode: 403 });
  return p;
}

export async function ssoAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  app.get("/", async (req) => {
    const p = req.principal!;
    const s = await ssoForOrg(p.orgId);
    const d = await pool.query<{ domain: string; verification_token: string; verified_at: string | null }>("SELECT domain, verification_token, verified_at FROM sso_domains WHERE org_id = $1 ORDER BY domain", [p.orgId]);
    const scim = await pool.query<{ prefix: string; created_at: string; last_used_at: string | null }>("SELECT prefix, created_at, last_used_at FROM scim_tokens WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [p.orgId]);
    return {
      redirectUri: redirectUri(),
      canEdit: p.role === "owner",
      config: s
        ? { enabled: s.enabled, issuer: s.issuer, clientId: s.client_id, hasSecret: !!s.client_secret_enc, jitProvisioning: s.jit_provisioning, defaultRole: s.default_role, enforce: s.enforce }
        : null,
      domains: d.rows.map((x) => ({
        domain: x.domain,
        verified: !!x.verified_at,
        verifiedAt: x.verified_at,
        // Only owners see the token: it is what proves control of the domain.
        record: p.role === "owner" ? { name: `_tessera-verify.${x.domain}`, type: "TXT", value: `tessera-verification=${x.verification_token}` } : null,
      })),
      scim: { baseUrl: `${config.publicUrl}/scim/v2`, token: scim.rows[0] ? { prefix: scim.rows[0].prefix, createdAt: scim.rows[0].created_at, lastUsedAt: scim.rows[0].last_used_at } : null },
    };
  });

  app.post("/test", async (req, reply) => {
    owner(req);
    const { issuer } = z.object({ issuer: z.string().trim().url().max(500) }).parse(req.body);
    try {
      const d = await discover(issuer.replace(/\/+$/, ""));
      return { ok: true, issuer: d.issuer, authorizationEndpoint: d.authorization_endpoint };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put("/", async (req, reply) => {
    const p = owner(req);
    const body = z
      .object({
        enabled: z.boolean(),
        issuer: z.string().trim().url().max(500),
        clientId: z.string().trim().min(1).max(300),
        clientSecret: z.string().max(2000).optional(),
        jitProvisioning: z.boolean().default(true),
        defaultRole: z.enum(["admin", "approver", "operator", "viewer"]).default("operator"),
        enforce: z.boolean().default(false),
        domains: z.array(Domain).max(50).default([]),
      })
      .parse(req.body);
    const issuer = body.issuer.replace(/\/+$/, "");
    const existing = await ssoForOrg(p.orgId);
    if (!body.clientSecret && !existing) return reply.code(400).send({ error: "Enter the client secret from your identity provider." });
    if (body.enforce && !body.enabled) return reply.code(400).send({ error: "Turn single sign-on on before requiring it." });
    const domains = [...new Set(body.domains)];
    const publicOnes = domains.filter((d) => PUBLIC_DOMAINS.has(d));
    if (publicOnes.length) return reply.code(400).send({ error: `${publicOnes.join(", ")} is a public email domain and cannot be used for single sign-on.` });
    if (body.enabled && !domains.length) return reply.code(400).send({ error: "Add at least one email domain so people can find your sign-in." });
    if (body.enabled) {
      try {
        await discover(issuer);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    const taken = await pool.query<{ domain: string }>("SELECT domain FROM sso_domains WHERE domain = ANY($1) AND org_id <> $2 AND verified_at IS NOT NULL", [domains, p.orgId]);
    if (taken.rowCount) return reply.code(409).send({ error: `${taken.rows.map((r) => r.domain).join(", ")} is verified by another organisation.` });

    const secretEnc = body.clientSecret ? encrypt(body.clientSecret) : existing!.client_secret_enc;
    await withTx(async (c) => {
      await c.query(
        `INSERT INTO org_sso (org_id, enabled, issuer, client_id, client_secret_enc, jit_provisioning, default_role, enforce, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
         ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
           client_secret_enc = EXCLUDED.client_secret_enc, jit_provisioning = EXCLUDED.jit_provisioning, default_role = EXCLUDED.default_role,
           enforce = EXCLUDED.enforce, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [p.orgId, body.enabled, issuer, body.clientId, secretEnc, body.jitProvisioning, body.defaultRole, body.enforce, p.userId],
      );
      // Keep the verification of domains that stay; new ones start unverified with a fresh token.
      await c.query("DELETE FROM sso_domains WHERE org_id = $1 AND NOT (domain = ANY($2))", [p.orgId, domains]);
      for (const d of domains) await c.query("INSERT INTO sso_domains (domain, org_id, verification_token) VALUES ($1, $2, $3) ON CONFLICT (org_id, domain) DO NOTHING", [d, p.orgId, randomBytes(16).toString("hex")]);
      await audit({
        orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "sso.update", targetType: "org", targetId: p.orgId,
        detail: { enabled: body.enabled, issuer, clientId: body.clientId, secretChanged: !!body.clientSecret, jitProvisioning: body.jitProvisioning, defaultRole: body.defaultRole, enforce: body.enforce, domains },
        ip: req.ip,
      }, c);
    });
    return { ok: true };
  });

  app.delete("/", async (req) => {
    const p = owner(req);
    await withTx(async (c) => {
      await c.query("DELETE FROM org_sso WHERE org_id = $1", [p.orgId]);
      await c.query("DELETE FROM sso_domains WHERE org_id = $1", [p.orgId]);
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "sso.delete", targetType: "org", targetId: p.orgId, ip: req.ip }, c);
    });
    return { ok: true };
  });

  /** Check a domain's TXT record and mark it verified when it carries this organisation's token. */
  app.post("/domains/:domain/verify", async (req, reply) => {
    const p = owner(req);
    const domain = Domain.parse((req.params as { domain: string }).domain);
    const r = await pool.query<{ verification_token: string; verified_at: string | null }>("SELECT verification_token, verified_at FROM sso_domains WHERE org_id = $1 AND domain = $2", [p.orgId, domain]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "That domain is not in your settings. Save it first." });
    if (row.verified_at) return { ok: true, verified: true };
    const expected = `tessera-verification=${row.verification_token}`;
    let found: string[] = [];
    try {
      found = (await txt.resolve(`_tessera-verify.${domain}`)).map((chunks) => chunks.join(""));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENOTFOUND" && code !== "ENODATA") return reply.code(502).send({ error: `DNS lookup failed (${code ?? (e as Error).message}). Try again in a minute.` });
    }
    if (!found.includes(expected)) {
      return reply.code(400).send({ error: found.length ? `_tessera-verify.${domain} has TXT records, but not this organisation's. It may take a few minutes for a new record to be seen.` : `No TXT record at _tessera-verify.${domain} yet. DNS changes can take a few minutes.` });
    }
    try {
      await pool.query("UPDATE sso_domains SET verified_at = now() WHERE org_id = $1 AND domain = $2", [p.orgId, domain]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: `${domain} is already verified by another organisation.` });
      throw e;
    }
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "sso.domain.verify", targetType: "domain", targetId: domain, ip: req.ip });
    return { ok: true, verified: true };
  });

  /** A new SCIM token replaces the previous one; it is shown once. */
  app.post("/scim/token", async (req) => {
    const p = owner(req);
    const token = newToken("tsc");
    await withTx(async (c) => {
      await c.query("UPDATE scim_tokens SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL", [p.orgId]);
      await c.query("INSERT INTO scim_tokens (org_id, token_hash, prefix, created_by) VALUES ($1,$2,$3,$4)", [p.orgId, sha256(token), token.slice(0, 12), p.userId]);
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "scim.token.create", targetType: "org", targetId: p.orgId, ip: req.ip }, c);
    });
    forgetScimTokens();
    return { ok: true, token, baseUrl: `${config.publicUrl}/scim/v2` };
  });

  app.delete("/scim/token", async (req) => {
    const p = owner(req);
    await pool.query("UPDATE scim_tokens SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL", [p.orgId]);
    forgetScimTokens();
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "scim.token.revoke", targetType: "org", targetId: p.orgId, ip: req.ip });
    return { ok: true };
  });

  /** Unlink a user's provider identity, e.g. after they were re-created at the provider. */
  app.post("/users/:id/unlink", async (req, reply) => {
    const p = owner(req);
    const { id } = req.params as { id: string };
    const r = await pool.query("UPDATE users SET sso_issuer = NULL, sso_subject = NULL WHERE id = $1 AND org_id = $2", [id, p.orgId]);
    if (!r.rowCount) return reply.code(404).send({ error: "no such user" });
    await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "sso.unlink", targetType: "user", targetId: id, ip: req.ip });
    return { ok: true };
  });
}
