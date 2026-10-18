/**
 * End-to-end single sign-on against a real OIDC exchange: a local provider
 * that serves discovery and keys, verifies PKCE on the token request, and
 * signs RS256 ID tokens; the app under test runs on a real PostgreSQL.
 * Skipped when no database is reachable.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

// ---- a minimal, real OIDC provider -------------------------------------------
interface IdpUser { sub: string; email: string; name?: string; email_verified?: boolean }
class TestIdp {
  url = "";
  clientId = "tessera-test";
  clientSecret = randomBytes(16).toString("hex");
  user: IdpUser = { sub: "u-1", email: "alice@acme-sso.test", name: "Alice" };
  tamper: { nonce?: string; aud?: string } = {};
  private codes = new Map<string, { nonce: string; challenge: string; redirect: string; user: IdpUser }>();
  private server!: http.Server;
  private key!: CryptoKey;
  private jwk!: Record<string, unknown>;

  async start() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    this.key = privateKey as CryptoKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    this.server.close();
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url!, this.url);
    if (u.pathname === "/.well-known/openid-configuration") {
      return this.json(res, 200, {
        issuer: this.url, authorization_endpoint: `${this.url}/authorize`, token_endpoint: `${this.url}/token`, jwks_uri: `${this.url}/jwks`,
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (u.pathname === "/jwks") return this.json(res, 200, { keys: [this.jwk] });
    if (u.pathname === "/authorize") {
      // The person "signs in" as this.user and approves.
      const p = u.searchParams;
      if (p.get("client_id") !== this.clientId || p.get("code_challenge_method") !== "S256" || p.get("response_type") !== "code") return this.json(res, 400, { error: "invalid_request" });
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, user: this.user });
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(p.get("state")!)}` });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      const [id, secret] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      if (id !== this.clientId || secret !== this.clientSecret) return this.json(res, 401, { error: "invalid_client" });
      const entry = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!entry) return this.json(res, 400, { error: "invalid_grant" });
      const verifierHash = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (verifierHash !== entry.challenge) return this.json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (form.get("redirect_uri") !== entry.redirect) return this.json(res, 400, { error: "invalid_grant" });
      const idToken = await new SignJWT({ email: entry.user.email, name: entry.user.name, nonce: this.tamper.nonce ?? entry.nonce, ...(entry.user.email_verified === undefined ? { email_verified: true } : { email_verified: entry.user.email_verified }) })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(this.url).setAudience(this.tamper.aud ?? this.clientId).setSubject(entry.user.sub)
        .setIssuedAt().setExpirationTime("5m")
        .sign(this.key);
      return this.json(res, 200, { access_token: "at", token_type: "Bearer", id_token: idToken });
    }
    return this.json(res, 404, {});
  }
}

// ---- helpers -------------------------------------------------------------------
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieOf = (setCookie: string | string[] | undefined, name: string): string | null => {
  for (const c of ([] as string[]).concat(setCookie ?? [])) if (c.startsWith(`${name}=`)) return c.split(";")[0]!;
  return null;
};

describe.skipIf(!reachable)("single sign-on (OIDC)", () => {
  const idp = new TestIdp();
  let app: FastifyInstance;
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const suffix = orgId.slice(0, 6);
  const ownerEmail = `owner-${suffix}@acme-sso.test`;
  let ownerCookie = "";

  /** Run the browser's side of a sign-in: start, the provider's redirect, the callback. */
  async function signIn(email: string): Promise<{ location: string; session: string | null }> {
    const start = await app.inject({ method: "GET", url: `/api/auth/sso/start?email=${encodeURIComponent(email)}&returnTo=/app/history` });
    if (start.statusCode !== 302) throw new Error(`start ${start.statusCode}`);
    const loc = start.headers.location as string;
    if (!loc.startsWith(idp.url)) return { location: loc, session: null };
    const flow = cookieOf(start.headers["set-cookie"], "tessera_sso")!;
    const back = await fetch(loc, { redirect: "manual" });
    const cb = new URL(back.headers.get("location")!);
    const done = await app.inject({ method: "GET", url: `${cb.pathname}${cb.search}`, headers: { cookie: flow } });
    return { location: done.headers.location as string, session: cookieOf(done.headers["set-cookie"], "tessera_session") };
  }

  beforeAll(async () => {
    process.env.PUBLIC_URL = "http://localhost:4700";
    await migrate(pool);
    await idp.start();
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme SSO', $2), ($3, 'Other Co', $4)", [orgId, `acme-sso-${suffix}`, otherOrg, `other-${suffix}`]);
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, 'Owner', 'owner', $3)", [orgId, ownerEmail, await hashPassword("owner-password-123")]);
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1, $2, 'Member', 'operator', $3)", [orgId, `member-${suffix}@acme-sso.test`, await hashPassword("member-password-123")]);
    await pool.query("INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, 'Outsider', 'owner')", [otherOrg, `outsider-${suffix}@acme-sso.test`]);
    const r = await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: ownerEmail, password: "owner-password-123" } });
    ownerCookie = cookieOf(r.headers["set-cookie"], "tessera_session")!;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, otherOrg]]);
    await app?.close();
    idp.stop();
    await pool.end();
  });

  const configure = (over: Record<string, unknown> = {}) =>
    app.inject({
      method: "PUT", url: "/api/admin/sso", headers: { ...H, cookie: ownerCookie },
      payload: { enabled: true, issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, jitProvisioning: true, defaultRole: "operator", enforce: false, domains: ["acme-sso.test"], ...over },
    });

  it("refuses public email domains and domains another organisation owns", async () => {
    expect((await configure({ domains: ["gmail.com"] })).statusCode).toBe(400);
    await pool.query("INSERT INTO sso_domains (domain, org_id) VALUES ($1, $2)", [`taken-${suffix}.test`, otherOrg]);
    const r = await configure({ domains: ["acme-sso.test", `taken-${suffix}.test`] });
    expect(r.statusCode).toBe(409);
  });

  it("saves the configuration after checking the provider's discovery document", async () => {
    const r = await configure();
    expect(r.statusCode).toBe(200);
    const g = await app.inject({ method: "GET", url: "/api/admin/sso", headers: { cookie: ownerCookie } });
    expect(g.json().config.hasSecret).toBe(true);
    expect(JSON.stringify(g.json())).not.toContain(idp.clientSecret);
    expect((await app.inject({ method: "GET", url: "/api/auth/sso/discover?email=anyone@acme-sso.test" })).json()).toMatchObject({ sso: true, orgName: "Acme SSO" });
  });

  it("signs a new person in through the provider and creates them with the default role", async () => {
    idp.user = { sub: `new-${suffix}`, email: `newbie-${suffix}@acme-sso.test`, name: "New Person" };
    const r = await signIn(idp.user.email);
    expect(r.location).toBe("/app/history");
    expect(r.session).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: r.session! } });
    expect(me.json().user).toMatchObject({ email: idp.user.email, name: "New Person", role: "operator" });
    const u = await pool.query("SELECT sso_subject FROM users WHERE lower(email) = $1", [idp.user.email]);
    expect(u.rows[0].sso_subject).toBe(`new-${suffix}`);
  });

  it("links an existing member on first SSO sign-in, then only that subject signs them in", async () => {
    const email = `member-${suffix}@acme-sso.test`;
    idp.user = { sub: `member-sub-${suffix}`, email };
    expect((await signIn(email)).session).toBeTruthy();
    idp.user = { sub: `someone-else-${suffix}`, email };
    const r = await signIn(email);
    expect(r.session).toBeNull();
    expect(decodeURIComponent(r.location)).toContain("linked to a different identity");
  });

  it("never signs in a user of another organisation, whatever the provider asserts", async () => {
    idp.user = { sub: `x-${suffix}`, email: `outsider-${suffix}@acme-sso.test` };
    const r = await signIn(idp.user.email);
    expect(r.session).toBeNull();
    expect(decodeURIComponent(r.location)).toContain("another Tessera organisation");
  });

  it("rejects an ID token with the wrong nonce or audience, or an unverified email", async () => {
    idp.user = { sub: `n-${suffix}`, email: `nonce-${suffix}@acme-sso.test` };
    idp.tamper = { nonce: "not-the-nonce" };
    expect((await signIn(idp.user.email)).location).toContain("sso_error");
    idp.tamper = { aud: "some-other-client" };
    expect((await signIn(idp.user.email)).location).toContain("sso_error");
    idp.tamper = {};
    idp.user = { sub: `v-${suffix}`, email: `unverified-${suffix}@acme-sso.test`, email_verified: false };
    const r = await signIn(idp.user.email);
    expect(r.session).toBeNull();
    expect(decodeURIComponent(r.location)).toContain("not verified");
  });

  it("refuses a callback whose state does not match the browser's sign-in", async () => {
    idp.user = { sub: `s-${suffix}`, email: `state-${suffix}@acme-sso.test` };
    const start = await app.inject({ method: "GET", url: `/api/auth/sso/start?email=${encodeURIComponent(idp.user.email)}` });
    const flow = cookieOf(start.headers["set-cookie"], "tessera_sso")!;
    const back = await fetch(start.headers.location as string, { redirect: "manual" });
    const cb = new URL(back.headers.get("location")!);
    cb.searchParams.set("state", "forged");
    const done = await app.inject({ method: "GET", url: `${cb.pathname}${cb.search}`, headers: { cookie: flow } });
    expect(done.headers.location).toContain("sso_error");
    // And without the browser's flow cookie at all (a link sent to someone else):
    const noCookie = await app.inject({ method: "GET", url: `${cb.pathname}?code=x&state=y` });
    expect(noCookie.headers.location).toContain("expired");
  });

  it("does not create accounts when automatic provisioning is off", async () => {
    expect((await configure({ jitProvisioning: false, clientSecret: undefined })).statusCode).toBe(200);
    idp.user = { sub: `j-${suffix}`, email: `jitless-${suffix}@acme-sso.test` };
    const r = await signIn(idp.user.email);
    expect(decodeURIComponent(r.location)).toContain("Ask an admin to invite you");
  });

  it("when SSO is required, members cannot use a password but owners can", async () => {
    expect((await configure({ enforce: true, clientSecret: undefined })).statusCode).toBe(200);
    const member = await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `member-${suffix}@acme-sso.test`, password: "member-password-123" } });
    expect(member.statusCode).toBe(403);
    const own = await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: ownerEmail, password: "owner-password-123" } });
    expect(own.statusCode).toBe(200);
  });

  it("writes every SSO sign-in and settings change to the audit log", async () => {
    const r = await pool.query<{ action: string }>("SELECT action FROM audit_log WHERE org_id = $1", [orgId]);
    const actions = r.rows.map((x) => x.action);
    expect(actions).toContain("sso.update");
    expect(actions).toContain("user.provision.sso");
    expect(actions).toContain("user.signin.sso");
  });
});
