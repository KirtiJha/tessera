import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createHash, randomBytes } from "node:crypto";

/**
 * A minimal, standards-following OIDC relying party: discovery, the
 * authorization-code flow with PKCE (S256), and ID-token validation against the
 * provider's published keys. No provider-specific code paths; Okta, Entra ID,
 * Google Workspace, Auth0 and Keycloak all speak this.
 */

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const discoveryCache = new Map<string, { doc: Discovery; until: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Issuers must be https, except loopback for local development and tests. */
export function validIssuer(issuer: string): boolean {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return false;
  }
  if (u.search || u.hash) return false;
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "https:" || (u.protocol === "http:" && loopback);
}

export async function discover(issuer: string, timeoutMs = 5000): Promise<Discovery> {
  const key = issuer.replace(/\/+$/, "");
  const hit = discoveryCache.get(key);
  if (hit && hit.until > Date.now()) return hit.doc;
  if (!validIssuer(key)) throw new OidcError("The issuer must be an https URL.");
  let res: Response;
  try {
    res = await fetch(`${key}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  } catch (e) {
    throw new OidcError(`Could not reach ${key}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new OidcError(`${key}/.well-known/openid-configuration answered ${res.status}.`);
  const doc = (await res.json()) as Discovery;
  for (const f of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[f] !== "string" || !doc[f]) throw new OidcError(`The provider's configuration has no ${f}.`);
  }
  // The issuer in the document must be the one configured (OIDC Discovery §4.3).
  if (doc.issuer.replace(/\/+$/, "") !== key) throw new OidcError(`The provider says its issuer is ${doc.issuer}, not ${key}.`);
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes("S256")) {
    throw new OidcError("The provider does not support PKCE with S256.");
  }
  discoveryCache.set(key, { doc, until: Date.now() + 60 * 60 * 1000 });
  return doc;
}

export class OidcError extends Error {}

export interface FlowState {
  orgId: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

export function newFlow(orgId: string, returnTo: string): FlowState {
  return {
    orgId,
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    returnTo,
    createdAt: Date.now(),
  };
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizationUrl(d: Discovery, clientId: string, redirectUri: string, flow: FlowState, loginHint?: string): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", flow.state);
  u.searchParams.set("nonce", flow.nonce);
  u.searchParams.set("code_challenge", challengeFor(flow.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

export interface Identity {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
}

/** Exchange the code, validate the ID token, and return who signed in. */
export async function finish(d: Discovery, clientId: string, clientSecret: string, redirectUri: string, code: string, flow: FlowState): Promise<Identity> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: flow.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (methods.includes("client_secret_basic")) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }
  let res: Response;
  try {
    res = await fetch(d.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new OidcError(`Could not reach the provider's token endpoint: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw new OidcError(`The provider refused the sign-in: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);

  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) jwksCache.set(d.jwks_uri, (jwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 5000, cooldownDuration: 30_000 })));
  let claims: JWTPayload & Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(json.id_token, jwks, {
      issuer: d.issuer,
      audience: clientId,
      clockTolerance: 60,
      algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"],
    }));
  } catch (e) {
    throw new OidcError(`The provider's ID token did not validate: ${(e as Error).message}`);
  }
  if (claims.nonce !== flow.nonce) throw new OidcError("The ID token's nonce does not match this sign-in.");
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) throw new OidcError("The ID token was issued to another client.");
  if (!claims.sub) throw new OidcError("The ID token has no subject.");

  // Entra ID often omits `email`; its preferred_username is the work address.
  const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OidcError("The provider did not send an email address for this account.");
  if (claims.email_verified === false || claims.email_verified === "false") throw new OidcError("The provider says this email address is not verified.");
  const name = typeof claims.name === "string" ? claims.name : [claims.given_name, claims.family_name].filter((x) => typeof x === "string").join(" ") || null;
  return { issuer: d.issuer, subject: String(claims.sub), email, name };
}

/** Domains nobody can claim for SSO routing: anyone can get an address there. */
export const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com",
  "163.com", "126.com", "rediffmail.com", "fastmail.com", "hey.com", "tutanota.com",
]);

export function domainOf(email: string): string {
  return email.split("@").pop()!.toLowerCase();
}

/** A same-site path to return to after sign-in; anything else becomes /app. */
export function safeReturnTo(v: unknown): string {
  return typeof v === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) && !v.startsWith("/api/") ? v : "/app";
}
