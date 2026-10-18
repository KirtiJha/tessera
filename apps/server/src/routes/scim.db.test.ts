/**
 * SCIM 2.0 provisioning as Okta and Entra ID drive it: find, create, update,
 * deactivate users; groups become teams.
 */
import { randomUUID } from "node:crypto";
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

const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe.skipIf(!reachable)("SCIM provisioning", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  const dom = `scim-${sfx}.test`;
  let owner = "";
  let ownerId = "";
  let token = "";
  let userId = "";
  const scim = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, t = token) =>
    app.inject({ method, url: `/scim/v2${url}`, headers: { authorization: `Bearer ${t}`, ...(payload ? { "content-type": "application/scim+json" } : {}) }, payload: payload as object });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'SCIM Co', $2)", [orgId, `scim-${sfx}`]);
    ownerId = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Olga Owner','owner',$3) RETURNING id", [orgId, `owner@${dom}`, await hashPassword("password-12345")])).rows[0]!.id;
    owner = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `owner@${dom}`, password: "password-12345" } }));
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("needs the organisation's SCIM token, made by an owner", async () => {
    expect((await scim("GET", "/Users", undefined, "tsc_nope")).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/api/admin/sso/scim/token", headers: { "x-tessera-client": "web", cookie: owner } });
    token = r.json().token;
    expect(token).toMatch(/^tsc_/);
    expect(r.json().baseUrl).toBe("http://localhost:4700/scim/v2");
    const cfg = await scim("GET", "/ServiceProviderConfig");
    expect(cfg.headers["content-type"]).toContain("application/scim+json");
    expect(cfg.json().patch.supported).toBe(true);
  });

  it("finds nobody, creates the person, and refuses a duplicate", async () => {
    const find = await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "ann@${dom}"`)}`);
    expect(find.json()).toMatchObject({ totalResults: 0, Resources: [] });
    const r = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `Ann@${dom}`, name: { givenName: "Ann", familyName: "Lee" }, emails: [{ value: `ann@${dom}`, primary: true }], externalId: "00u1", active: true });
    expect(r.statusCode).toBe(201);
    userId = r.json().id;
    expect(r.json()).toMatchObject({ userName: `ann@${dom}`, displayName: "Ann Lee", active: true, externalId: "00u1" });
    const u = await pool.query("SELECT role, status FROM users WHERE id = $1", [userId]);
    expect(u.rows[0]).toEqual({ role: "operator", status: "active" });
    const dup = await scim("POST", "/Users", { userName: `ann@${dom}` });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "00u1"')}`)).json().totalResults).toBe(1);
  });

  it("deactivates (Entra-style PATCH), ending their browser sessions, and reactivates (Okta-style)", async () => {
    await pool.query("INSERT INTO user_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [`sess-${sfx}`, userId]);
    const off = await scim("PATCH", `/Users/${userId}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] });
    expect(off.json().active).toBe(false);
    expect((await pool.query("SELECT 1 FROM user_sessions WHERE user_id = $1", [userId])).rowCount).toBe(0);
    const on = await scim("PATCH", `/Users/${userId}`, { Operations: [{ op: "replace", value: { active: true, name: { givenName: "Annie" } } }] });
    expect(on.json()).toMatchObject({ active: true, displayName: "Annie Lee" });
    const a = await pool.query("SELECT action, actor_name FROM audit_log WHERE org_id = $1 AND action LIKE 'scim.user.%' ORDER BY id", [orgId]);
    expect(a.rows.map((r) => r.action)).toEqual(["scim.user.create", "scim.user.deactivate", "scim.user.update"]);
    expect(a.rows[0]!.actor_name).toBe("SCIM");
  });

  it("never deactivates an owner, and DELETE disables rather than erases", async () => {
    const r = await scim("PATCH", `/Users/${ownerId}`, { Operations: [{ op: "replace", path: "active", value: false }] });
    expect(r.statusCode).toBe(403);
    expect(r.json().scimType).toBe("mutability");
    expect((await scim("DELETE", `/Users/${userId}`)).statusCode).toBe(204);
    expect((await pool.query("SELECT status FROM users WHERE id = $1", [userId])).rows[0].status).toBe("disabled");
    await scim("PATCH", `/Users/${userId}`, { Operations: [{ op: "replace", path: "active", value: true }] });
  });

  it("turns groups into teams and keeps membership in step", async () => {
    const g = await scim("POST", "/Groups", { displayName: "Payments", externalId: "grp-1", members: [{ value: userId }] });
    expect(g.statusCode).toBe(201);
    const teamId = g.json().id;
    expect((await pool.query("SELECT team_id FROM users WHERE id = $1", [userId])).rows[0].team_id).toBe(teamId);
    await scim("PATCH", `/Groups/${teamId}`, { Operations: [{ op: "remove", path: `members[value eq "${userId}"]` }] });
    expect((await pool.query("SELECT team_id FROM users WHERE id = $1", [userId])).rows[0].team_id).toBeNull();
    await scim("PATCH", `/Groups/${teamId}`, { Operations: [{ op: "add", path: "members", value: [{ value: userId }] }, { op: "replace", path: "displayName", value: "Payments Core" }] });
    const got = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "payments core"')}&excludedAttributes=members`);
    expect(got.json().Resources[0]).not.toHaveProperty("members");
    expect((await scim("GET", `/Groups/${teamId}`)).json().members).toEqual([expect.objectContaining({ value: userId, display: "Annie Lee" })]);
    expect((await scim("DELETE", `/Groups/${teamId}`)).statusCode).toBe(204);
    expect((await pool.query("SELECT team_id FROM users WHERE id = $1", [userId])).rows[0].team_id).toBeNull();
  });

  it("stops the old token at once when an owner rotates it", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/sso/scim/token", headers: { "x-tessera-client": "web", cookie: owner } });
    expect((await scim("GET", "/Users")).statusCode).toBe(401);
    expect((await scim("GET", "/Users", undefined, r.json().token)).statusCode).toBe(200);
    expect((await scim("GET", "/Nope", undefined, r.json().token)).statusCode).toBe(404);
  });
});
