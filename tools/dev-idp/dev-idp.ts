/**
 * A local OpenID Connect provider for development: discovery, JWKS, an
 * authorization page where you type who you are, PKCE-checked code exchange
 * and RS256 ID tokens. It trusts whatever email you type, so never expose it.
 *
 *   pnpm --filter @tessera/dev-idp start            # http://127.0.0.1:4800
 *
 * In Tessera → Single sign-on use issuer http://127.0.0.1:4800, client ID
 * "tessera-dev" and client secret "dev-secret" (override with DEV_IDP_* env).
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.env.DEV_IDP_PORT ?? 4800);
const HOST = "127.0.0.1";
const ISSUER = `http://${HOST}:${PORT}`;
const CLIENT_ID = process.env.DEV_IDP_CLIENT_ID ?? "tessera-dev";
const CLIENT_SECRET = process.env.DEV_IDP_CLIENT_SECRET ?? "dev-secret";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "dev-1", alg: "RS256", use: "sig" };
const pending = new Map<string, { params: URLSearchParams }>();
const codes = new Map<string, { nonce: string; challenge: string; redirect: string; email: string; name: string; at: number }>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = async (req: http.IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return new URLSearchParams(raw);
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url!, ISSUER);
    if (u.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["openid", "email", "profile"],
      });
    }
    if (u.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (u.pathname === "/authorize" && req.method === "GET") {
      const p = u.searchParams;
      if (p.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "unauthorized_client" });
      if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "code flow with PKCE S256 required" });
      const id = randomBytes(12).toString("hex");
      pending.set(id, { params: p });
      const hint = p.get("login_hint") ?? "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev identity provider</title>
<style>body{font:15px system-ui;background:#f3f4f6;margin:0;display:grid;place-items:center;min-height:100vh}form{background:#fff;padding:28px;border-radius:12px;width:min(360px,90vw);box-shadow:0 10px 30px -15px #0003}
h1{font-size:18px;margin:0 0 4px}p{color:#666;font-size:13px;margin:0 0 18px}label{display:block;font-size:13px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:8px;font:inherit}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;cursor:pointer}</style>
<form method="post" action="/authorize"><h1>Dev identity provider</h1><p>Signing in to ${esc(CLIENT_ID)}. Development only: whoever you type is who you are.</p>
<input type="hidden" name="id" value="${id}"><label>Email</label><input name="email" type="email" required value="${esc(hint)}">
<label>Name</label><input name="name" value="${esc(hint.split("@")[0] ?? "")}"><button>Sign in</button></form>`);
    }
    if (u.pathname === "/authorize" && req.method === "POST") {
      const f = await readBody(req);
      const entry = pending.get(f.get("id") ?? "");
      pending.delete(f.get("id") ?? "");
      if (!entry) return json(res, 400, { error: "invalid_request" });
      const p = entry.params;
      const code = randomBytes(16).toString("hex");
      codes.set(code, { nonce: p.get("nonce") ?? "", challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, email: (f.get("email") ?? "").toLowerCase(), name: f.get("name") ?? "", at: Date.now() });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      if (p.get("state")) back.searchParams.set("state", p.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const f = await readBody(req);
      const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
      const [bid, bsecret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [f.get("client_id"), f.get("client_secret")];
      if (bid !== CLIENT_ID || bsecret !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });
      const c = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      if (!c || Date.now() - c.at > 60_000) return json(res, 400, { error: "invalid_grant" });
      if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (f.get("redirect_uri") !== c.redirect) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      const sub = createHash("sha256").update(c.email).digest("hex").slice(0, 24);
      const idToken = await new SignJWT({ email: c.email, email_verified: true, name: c.name || undefined, nonce: c.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "dev-1" })
        .setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject(sub).setIssuedAt().setExpirationTime("5m")
        .sign(privateKey);
      return json(res, 200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(res, 404, { error: "not_found" });
  })
  .listen(PORT, HOST, () => console.log(`dev identity provider on ${ISSUER} (client ${CLIENT_ID} / ${CLIENT_SECRET})`));
