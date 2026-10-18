/**
 * Regression tests for the independent security review: a device cannot read
 * or answer another person's session channel; viewers cannot enrol machines;
 * admins cannot attach people to another organisation's team; concurrent audit
 * writes keep one chain; API key scopes match the decoded path.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { issueDevice } from "../auth/devices.js";
import { audit, verifyChain } from "../audit.js";
import { scopeFor } from "../auth/apikeys.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe("scopes match the path the router sees", () => {
  it("decodes before matching", () => {
    expect(scopeFor("GET", "/api/analytics/%73ettings")).toBeNull();
    expect(scopeFor("GET", "/api/analytics/settings")).toBeNull();
    expect(scopeFor("GET", "/api/analytics/%E0%A4%A")).toBeNull();
    expect(scopeFor("GET", "/api/analytics?days=7")).toBe("analytics:read");
  });
});

describe.skipIf(!reachable)("review fixes", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const other = randomUUID();
  const sfx = orgId.slice(0, 6);
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let ownerToken = "";
  let mateToken = "";
  const sid = `rev-${sfx}`;

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Rev A',$2), ($3,'Rev B',$4)", [orgId, `rev-a-${sfx}`, other, `rev-b-${sfx}`]);
    const pw = await hashPassword("password-12345");
    for (const [who, role] of [["adam", "admin"], ["olly", "operator"], ["mia", "operator"], ["vera", "viewer"]] as const) {
      ids[who] = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id", [orgId, `${who}-${sfx}@rev.test`, who, role, pw])).rows[0]!.id;
      cookies[who] = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `${who}-${sfx}@rev.test`, password: "password-12345" } }));
    }
    ids.otherTeam = (await pool.query<{ id: string }>("INSERT INTO teams (org_id, name, slug) VALUES ($1,'Secret','secret') RETURNING id", [other])).rows[0]!.id;
    ownerToken = (await issueDevice(orgId, ids.olly!, "olly-laptop")).token;
    mateToken = (await issueDevice(orgId, ids.mia!, "mia-laptop")).token;
    await app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sid, status: "waiting", waitReason: "permission", startedAt: new Date().toISOString(), openAsk: { id: "ask-r", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(x)" } }, events: [] },
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, other]]);
    await pool.end();
  });

  it("keeps another person's device out of a session's deliveries, decisions and results", async () => {
    await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/answer`, headers: { ...H, cookie: cookies.adam! }, payload: { askId: "ask-r", decision: "allow" } });
    await app.inject({ method: "POST", url: `/api/fleet/sessions/${sid}/stop`, headers: { ...H, cookie: cookies.adam! }, payload: {} });
    const stolen = await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries`, headers: { authorization: `Bearer ${mateToken}` } });
    expect(stolen.json().deliveries).toEqual([]);
    const decide = await app.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${mateToken}`, "content-type": "application/json" }, payload: { sessionId: sid, tool: "Bash" } });
    expect(decide.json()).toEqual({ decision: "allow", reason: null });
    // The owner's machine still gets both: the answer, and the stop.
    const mine = await app.inject({ method: "GET", url: `/api/ingest/sessions/${sid}/deliveries`, headers: { authorization: `Bearer ${ownerToken}` } });
    const d = mine.json().deliveries;
    expect(d).toHaveLength(1);
    const forged = await app.inject({ method: "POST", url: `/api/ingest/deliveries/${d[0].id}/result`, headers: { authorization: `Bearer ${mateToken}`, "content-type": "application/json" }, payload: { result: { applied: false } } });
    expect(forged.statusCode).toBe(404);
    const real = await app.inject({ method: "POST", url: `/api/ingest/deliveries/${d[0].id}/result`, headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, payload: { result: { applied: true } } });
    expect(real.statusCode).toBe(200);
    const stop = await app.inject({ method: "POST", url: "/api/ingest/decide", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, payload: { sessionId: sid, tool: "Bash" } });
    expect(stop.json()).toMatchObject({ decision: "deny", stop: true });
  });

  it("does not let viewers enrol machines", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/devices", headers: { ...H, cookie: cookies.vera! }, payload: { label: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/devices/enrolment-code", headers: { "x-tessera-client": "web", cookie: cookies.vera! } })).statusCode).toBe(403);
    const code = (await app.inject({ method: "POST", url: "/api/admin/devices/enrolment-code", headers: { "x-tessera-client": "web", cookie: cookies.olly! } })).json().code;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("refuses another organisation's team", async () => {
    const r = await app.inject({ method: "PATCH", url: `/api/admin/users/${ids.adam}`, headers: { ...H, cookie: cookies.adam! }, payload: { teamId: ids.otherTeam } });
    expect(r.statusCode).toBe(400);
    const inv = await app.inject({ method: "POST", url: "/api/admin/users/invite", headers: { ...H, cookie: cookies.adam! }, payload: { email: `x-${sfx}@rev.test`, name: "X", teamId: ids.otherTeam } });
    expect(inv.statusCode).toBe(400);
  });

  it("keeps one audit chain under concurrent writers", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit({ orgId, actorId: null, actorName: "load", action: `test.concurrent.${i}` })));
    expect(await verifyChain(orgId)).toMatchObject({ ok: true });
  });

  it("refuses impossible dates instead of failing", async () => {
    const r = await app.inject({ method: "GET", url: "/api/analytics?from=2026-02-31&to=2026-03-02", headers: { cookie: cookies.adam! } });
    expect(r.statusCode).toBe(400);
  });
});
