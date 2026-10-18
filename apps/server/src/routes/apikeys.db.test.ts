/**
 * The public API: API keys act as their maker, limited to their scopes, on the
 * console's own endpoints under /api/v1.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { issueDevice } from "../auth/devices.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe.skipIf(!reachable)("API keys and /api/v1", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  const sid = `api-${sfx}`;
  const c: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
  const makeKey = async (who: string, scopes: string[], extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/keys", headers: { ...H, cookie: c[who]! }, payload: { name: `${who}-key`, scopes, ...extra } });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'API Co', $2)", [orgId, `api-${sfx}`]);
    const pw = await hashPassword("password-12345");
    for (const [who, role] of [["otto", "operator"], ["ada", "admin"]] as const) {
      const r = await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id", [orgId, `${who}-${sfx}@api.test`, who[0]!.toUpperCase() + who.slice(1), role, pw]);
      ids[who] = r.rows[0]!.id;
      c[who] = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `${who}-${sfx}@api.test`, password: "password-12345" } }));
    }
    const device = (await issueDevice(orgId, ids.otto!, "laptop")).token;
    await app.inject({ method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${device}`, "content-type": "application/json" }, payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sid, status: "running", startedAt: new Date().toISOString() }, events: [] } });
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("lets people grant only scopes their role allows, and shows the token once", async () => {
    expect((await makeKey("otto", ["fleet:read", "audit:read"])).statusCode).toBe(403);
    const r = await makeKey("otto", ["fleet:read", "sessions:act"]);
    expect(r.json().token).toMatch(/^tsk_/);
    const list = (await app.inject({ method: "GET", url: "/api/keys", headers: { cookie: c.otto! } })).json();
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(r.json().token);
    expect(list.keys[0].prefix).toBe(r.json().token.slice(0, 12));
  });

  it("reads and acts through /api/v1 as its maker, without the browser's CSRF header", async () => {
    const token = (await makeKey("otto", ["fleet:read", "sessions:act"])).json().token;
    const state = await app.inject({ method: "GET", url: "/api/v1/fleet/state", headers: bearer(token) });
    expect(state.statusCode).toBe(200);
    expect(state.json().sessions.map((s: { id: string }) => s.id)).toContain(sid);
    const pause = await app.inject({ method: "POST", url: `/api/v1/fleet/sessions/${sid}/pause`, headers: bearer(token, { "content-type": "application/json" }), payload: { paused: true, reason: "CI freeze" } });
    expect(pause.statusCode).toBe(200);
    const a = await pool.query("SELECT actor_name FROM audit_log WHERE org_id = $1 AND action = 'session.pause'", [orgId]);
    expect(a.rows[0]!.actor_name).toBe("Otto (API key otto-key)");
    // A browser request without the header is still refused.
    const csrf = await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/pause`, headers: { cookie: c.otto!, "content-type": "application/json" }, payload: { paused: false } });
    expect(csrf.statusCode).toBe(403);
  });

  it("refuses what the key's scopes or kind do not cover", async () => {
    const ro = (await makeKey("otto", ["fleet:read"])).json().token;
    expect((await app.inject({ method: "POST", url: `/api/v1/fleet/sessions/${sid}/pause`, headers: bearer(ro, { "content-type": "application/json" }), payload: { paused: false } })).json().error).toContain("sessions:act");
    expect((await app.inject({ method: "GET", url: "/api/v1/keys", headers: bearer(ro) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: bearer(ro) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/fleet/state", headers: bearer("tsk_not-a-real-key") })).statusCode).toBe(401);
  });

  it("follows its maker: a demotion narrows it, a revocation or expiry ends it", async () => {
    const t = (await makeKey("ada", ["audit:read", "fleet:read"])).json().token;
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/audit?limit=5", headers: bearer(t) })).statusCode).toBe(200);
    // The owner-less test org has no owner; demote Ada directly.
    await pool.query("UPDATE users SET role = 'operator' WHERE id = $1", [ids.ada]);
    const { forgetApiKeys } = await import("../auth/apikeys.js");
    forgetApiKeys();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: bearer(t) })).json().error).toContain("audit:read");
    expect((await app.inject({ method: "GET", url: "/api/v1/fleet/state", headers: bearer(t) })).statusCode).toBe(200);

    const keys = (await app.inject({ method: "GET", url: "/api/keys", headers: { cookie: c.ada! } })).json().keys;
    expect((await app.inject({ method: "DELETE", url: `/api/keys/${keys[0].id}`, headers: { "x-tessera-client": "web", cookie: c.ada! } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/fleet/state", headers: bearer(t) })).statusCode).toBe(401);

    const old = (await makeKey("otto", ["fleet:read"])).json();
    await pool.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [old.id]);
    forgetApiKeys();
    expect((await app.inject({ method: "GET", url: "/api/v1/fleet/state", headers: bearer(old.token) })).statusCode).toBe(401);
  });

  it("publishes an OpenAPI document without a key", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/fleet/sessions/{id}/answer"].post["x-scope"]).toBe("sessions:act");
  });
});
