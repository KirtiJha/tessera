import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "../audit.js";
import { forgetApiKeys } from "../auth/apikeys.js";
import { sha256 } from "../auth/crypto.js";
import { config } from "../config.js";
import { pool, withTx, type Queryable } from "../db/pool.js";

/**
 * SCIM 2.0 (RFC 7643/7644) for Okta, Microsoft Entra ID and others: users are
 * created, updated and deactivated by the identity provider; groups become
 * teams. Roles stay a Tessera decision. Owners cannot be deactivated through
 * SCIM, so the provider can never lock an organisation out of itself.
 */

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

interface ScimOrg {
  orgId: string;
  tokenId: string;
}
declare module "fastify" {
  interface FastifyRequest {
    scim: ScimOrg | null;
  }
}

class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: string,
  ) {
    super(message);
  }
}

const base = () => `${config.publicUrl}/scim/v2`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  given_name: string | null;
  family_name: string | null;
  status: string;
  role: string;
  team_id: string | null;
  scim_external_id: string | null;
  created_at: string;
}

function userOut(u: UserRow) {
  return {
    schemas: [USER],
    id: u.id,
    ...(u.scim_external_id ? { externalId: u.scim_external_id } : {}),
    userName: u.email,
    name: { formatted: u.name, ...(u.given_name ? { givenName: u.given_name } : {}), ...(u.family_name ? { familyName: u.family_name } : {}) },
    displayName: u.name,
    emails: [{ value: u.email, type: "work", primary: true }],
    active: u.status === "active",
    meta: { resourceType: "User", created: new Date(u.created_at).toISOString(), location: `${base()}/Users/${u.id}` },
  };
}

/** `attr eq "value"` (the only filter IdPs send in practice). */
function parseFilter(f: string | undefined): { attr: string; value: string } | null {
  if (!f) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(f);
  if (!m) throw new ScimError(400, "Only `attribute eq \"value\"` filters are supported.", "invalidFilter");
  return { attr: m[1]!.toLowerCase(), value: m[2]!.replace(/\\"/g, '"') };
}

function page(q: Record<string, string | undefined>): { start: number; count: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Math.trunc(Number(v ?? d));
    return Number.isFinite(x) ? x : d;
  };
  const start = Math.min(1_000_000, Math.max(1, n(q.startIndex, 1)));
  const count = Math.min(200, Math.max(0, n(q.count, 100)));
  return { start, count };
}

const USER_COLS = "id, email, name, given_name, family_name, status, role, team_id, scim_external_id, created_at";

async function loadUser(q: Queryable, orgId: string, id: string): Promise<UserRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, "No such user.");
  const r = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE org_id = $1 AND id = $2`, [orgId, id]);
  if (!r.rows[0]) throw new ScimError(404, "No such user.");
  return r.rows[0];
}

/** The attributes Tessera keeps, from a SCIM user body (full or partial). */
interface UserPatch {
  email?: string;
  given?: string | null;
  family?: string | null;
  display?: string | null;
  active?: boolean;
  externalId?: string | null;
}
function fromScimUser(body: Record<string, unknown>): UserPatch {
  const out: UserPatch = {};
  const emails = body.emails as { value?: string; primary?: boolean }[] | undefined;
  const email = (typeof body.userName === "string" && body.userName.includes("@") ? body.userName : emails?.find((e) => e.primary)?.value ?? emails?.[0]?.value) as string | undefined;
  if (email) out.email = email.trim().toLowerCase();
  const name = body.name as { givenName?: string; familyName?: string; formatted?: string } | undefined;
  if (name?.givenName !== undefined) out.given = name.givenName;
  if (name?.familyName !== undefined) out.family = name.familyName;
  if (typeof body.displayName === "string") out.display = body.displayName;
  else if (name?.formatted) out.display = name.formatted;
  if (body.active !== undefined) out.active = body.active === true || body.active === "true" || body.active === "True";
  if (body.externalId !== undefined) out.externalId = body.externalId as string | null;
  return out;
}

const fullName = (p: UserPatch, fallback: string) => (p.display?.trim() || [p.given, p.family].filter(Boolean).join(" ").trim() || fallback).slice(0, 200);

const tokens = new Map<string, { v: ScimOrg | null; until: number }>();
/** Forget cached tokens so a revoked or rotated one stops working at once. */
export function forgetScimTokens(): void {
  tokens.clear();
}

export async function scimRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/scim+json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.decorateRequest("scim", null);

  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer tsc_")) return reply.code(401).header("www-authenticate", "Bearer").send({ schemas: [ERROR], status: "401", detail: "A SCIM token is required." });
    const h = sha256(auth.slice(7).trim());
    let hit = tokens.get(h);
    if (!hit || hit.until < Date.now()) {
      const r = await pool.query<{ id: string; org_id: string }>("SELECT id, org_id FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL", [h]);
      hit = { v: r.rows[0] ? { orgId: r.rows[0].org_id, tokenId: r.rows[0].id } : null, until: Date.now() + 15_000 };
      tokens.set(h, hit);
      if (hit.v) void pool.query("UPDATE scim_tokens SET last_used_at = now() WHERE id = $1", [hit.v.tokenId]).catch(() => {});
    }
    if (!hit.v) return reply.code(401).send({ schemas: [ERROR], status: "401", detail: "The SCIM token is not valid. Generate a new one under Single sign-on." });
    req.scim = hit.v;
    reply.header("content-type", "application/scim+json; charset=utf-8");
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { status?: number; statusCode?: number; scimType?: string };
    const status = e instanceof ScimError ? e.status : (e.statusCode ?? 500);
    if (status >= 500) req.log.error({ err: e }, "scim request failed");
    return reply.code(status).send({ schemas: [ERROR], status: String(status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: status >= 500 ? "internal error" : e.message });
  });

  const org = (req: FastifyRequest) => req.scim!.orgId;
  const log = (orgId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown>, q?: Queryable) =>
    audit({ orgId, actorId: null, actorName: "SCIM", action, targetType, targetId, detail }, q);

  // ---- discovery ------------------------------------------------------------
  app.get("/ServiceProviderConfig", async () => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: `${config.publicUrl}/app/sso`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "A token generated under Single sign-on → Provisioning", primary: true }],
  }));
  app.get("/ResourceTypes", async () => ({
    schemas: [LIST],
    totalResults: 2,
    Resources: [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
    ],
  }));
  app.get("/Schemas", async () => ({ schemas: [LIST], totalResults: 2, Resources: [{ id: USER, name: "User" }, { id: GROUP, name: "Group" }] }));

  // ---- users ----------------------------------------------------------------
  app.get("/Users", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const f = parseFilter(q.filter);
    const { start, count } = page(q);
    const params: unknown[] = [org(req)];
    let where = "org_id = $1";
    if (f) {
      if (f.attr === "username" || f.attr === "emails.value" || f.attr === "emails") where += ` AND lower(email) = lower($${params.push(f.value)})`;
      else if (f.attr === "externalid") where += ` AND scim_external_id = $${params.push(f.value)}`;
      else if (f.attr === "id") where += ` AND id::text = $${params.push(f.value)}`;
      else throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, "invalidFilter");
    }
    const total = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
    const rows = await pool.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE ${where} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`, params);
    return { schemas: [LIST], totalResults: total.rows[0]!.n, startIndex: start, itemsPerPage: rows.rows.length, Resources: rows.rows.map(userOut) };
  });

  app.get("/Users/:id", async (req) => userOut(await loadUser(pool, org(req), (req.params as { id: string }).id)));

  app.post("/Users", async (req, reply) => {
    const orgId = org(req);
    const p = fromScimUser(req.body as Record<string, unknown>);
    if (!p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new ScimError(400, "userName must be the person's email address.", "invalidValue");
    const exists = await pool.query<{ org_id: string }>("SELECT org_id FROM users WHERE lower(email) = $1", [p.email]);
    if (exists.rows[0]) throw new ScimError(409, exists.rows[0].org_id === orgId ? "A user with that email exists. Match on userName instead." : "A user with that email cannot be created here.", "uniqueness");
    const role = (await pool.query<{ default_role: string }>("SELECT default_role FROM org_sso WHERE org_id = $1", [orgId])).rows[0]?.default_role ?? "operator";
    const r = await pool.query<UserRow>(
      `INSERT INTO users (org_id, email, name, given_name, family_name, role, status, scim_external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${USER_COLS}`,
      [orgId, p.email, fullName(p, p.email.split("@")[0]!), p.given ?? null, p.family ?? null, role, p.active === false ? "disabled" : "active", p.externalId ?? null],
    );
    await log(orgId, "scim.user.create", "user", r.rows[0]!.id, { email: p.email, role, active: p.active !== false });
    return reply.code(201).header("location", `${base()}/Users/${r.rows[0]!.id}`).send(userOut(r.rows[0]!));
  });

  async function applyUser(orgId: string, id: string, p: UserPatch, replace: boolean): Promise<UserRow> {
    return withTx(async (c) => {
      const u = await loadUser(c, orgId, id);
      if (p.active === false && u.role === "owner") throw new ScimError(403, "Owners are managed in Tessera and cannot be deactivated through SCIM.", "mutability");
      if (p.email && p.email !== u.email.toLowerCase()) {
        const clash = await c.query("SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2", [p.email, id]);
        if (clash.rowCount) throw new ScimError(409, "Another user already has that email.", "uniqueness");
      }
      const next = {
        email: p.email ?? u.email,
        given: p.given !== undefined ? p.given : replace ? null : u.given_name,
        family: p.family !== undefined ? p.family : replace ? null : u.family_name,
        name: p.display !== undefined || p.given !== undefined || p.family !== undefined ? fullName({ ...p, given: p.given ?? u.given_name, family: p.family ?? u.family_name }, u.name) : u.name,
        status: p.active === undefined ? u.status : p.active ? (u.status === "disabled" || u.status === "invited" ? "active" : u.status) : "disabled",
        externalId: p.externalId !== undefined ? p.externalId : u.scim_external_id,
      };
      const r = await c.query<UserRow>(
        `UPDATE users SET email = $3, given_name = $4, family_name = $5, name = $6, status = $7, scim_external_id = $8 WHERE org_id = $1 AND id = $2 RETURNING ${USER_COLS}`,
        [orgId, id, next.email, next.given, next.family, next.name, next.status, next.externalId],
      );
      if (next.status === "disabled" && u.status !== "disabled") {
        // Deprovisioned: end their browser sessions now; devices and API keys stop at their next check.
        await c.query("DELETE FROM user_sessions WHERE user_id = $1", [id]);
        forgetApiKeys();
      }
      const changed = Object.fromEntries(Object.entries({ email: next.email !== u.email, name: next.name !== u.name, status: next.status !== u.status }).filter(([, v]) => v).map(([k]) => [k, (next as Record<string, unknown>)[k]]));
      if (Object.keys(changed).length) await log(orgId, next.status === "disabled" && u.status !== "disabled" ? "scim.user.deactivate" : "scim.user.update", "user", id, changed, c);
      return r.rows[0]!;
    });
  }

  app.put("/Users/:id", async (req) => userOut(await applyUser(org(req), (req.params as { id: string }).id, fromScimUser(req.body as Record<string, unknown>), true)));

  app.patch("/Users/:id", async (req) => {
    const body = req.body as { Operations?: { op: string; path?: string; value?: unknown }[] };
    const p: UserPatch = {};
    for (const op of body.Operations ?? []) {
      const kind = op.op.toLowerCase();
      if (kind !== "replace" && kind !== "add") throw new ScimError(400, `Operation ${op.op} is not supported on users.`, "invalidSyntax");
      const path = op.path?.toLowerCase();
      if (!path) Object.assign(p, fromScimUser(op.value as Record<string, unknown>));
      else if (path === "active") p.active = op.value === true || op.value === "true" || op.value === "True";
      else if (path === "username") p.email = String(op.value).trim().toLowerCase();
      else if (path === "displayname") p.display = String(op.value);
      else if (path === "name.givenname") p.given = String(op.value);
      else if (path === "name.familyname") p.family = String(op.value);
      else if (path === "externalid") p.externalId = String(op.value);
      else if (path.startsWith("emails")) p.email = String(Array.isArray(op.value) ? (op.value[0] as { value: string }).value : op.value).trim().toLowerCase();
      // Other attributes (title, phone numbers, …) are accepted and ignored.
    }
    return userOut(await applyUser(org(req), (req.params as { id: string }).id, p, false));
  });

  app.delete("/Users/:id", async (req, reply) => {
    await applyUser(org(req), (req.params as { id: string }).id, { active: false }, false);
    return reply.code(204).send();
  });

  // ---- groups → teams ----------------------------------------------------------
  interface TeamRow {
    id: string;
    org_id: string;
    name: string;
    scim_external_id: string | null;
    created_at: string;
  }
  async function groupOut(t: TeamRow, withMembers = true) {
    const members = withMembers ? (await pool.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE team_id = $1 AND org_id = $2 ORDER BY name", [t.id, t.org_id])).rows : [];
    return {
      schemas: [GROUP],
      id: t.id,
      displayName: t.name,
      ...(t.scim_external_id ? { externalId: t.scim_external_id } : {}),
      ...(withMembers ? { members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${base()}/Users/${m.id}` })) } : {}),
      meta: { resourceType: "Group", created: new Date(t.created_at).toISOString(), location: `${base()}/Groups/${t.id}` },
    };
  }
  async function loadTeam(q: Queryable, orgId: string, id: string): Promise<TeamRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, "No such group.");
    const r = await q.query<TeamRow>("SELECT id, org_id, name, scim_external_id, created_at FROM teams WHERE org_id = $1 AND id = $2", [orgId, id]);
    if (!r.rows[0]) throw new ScimError(404, "No such group.");
    return r.rows[0];
  }
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
  async function setMembers(c: Queryable, orgId: string, teamId: string, add: string[], remove: string[] | "all"): Promise<void> {
    if (remove === "all") await c.query("UPDATE users SET team_id = NULL WHERE org_id = $1 AND team_id = $2", [orgId, teamId]);
    else if (remove.length) await c.query("UPDATE users SET team_id = NULL WHERE org_id = $1 AND team_id = $2 AND id::text = ANY($3)", [orgId, teamId, remove]);
    // A person is in one team; the group that adds them last wins.
    if (add.length) await c.query("UPDATE users SET team_id = $2 WHERE org_id = $1 AND id::text = ANY($3)", [orgId, teamId, add]);
  }
  const memberIds = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((m) => String((m as { value?: string }).value ?? m)).filter((x) => /^[0-9a-f-]{36}$/i.test(x));

  app.get("/Groups", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const f = parseFilter(q.filter);
    const { start, count } = page(q);
    const params: unknown[] = [org(req)];
    let where = "org_id = $1";
    if (f) {
      if (f.attr === "displayname") where += ` AND lower(name) = lower($${params.push(f.value)})`;
      else if (f.attr === "externalid") where += ` AND scim_external_id = $${params.push(f.value)}`;
      else if (f.attr === "id") where += ` AND id::text = $${params.push(f.value)}`;
      else throw new ScimError(400, `Filtering on ${f.attr} is not supported.`, "invalidFilter");
    }
    const total = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM teams WHERE ${where}`, params);
    const rows = await pool.query<TeamRow>(`SELECT id, org_id, name, scim_external_id, created_at FROM teams WHERE ${where} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`, params);
    const withMembers = !(q.excludedAttributes ?? "").split(",").includes("members");
    return { schemas: [LIST], totalResults: total.rows[0]!.n, startIndex: start, itemsPerPage: rows.rows.length, Resources: await Promise.all(rows.rows.map((t) => groupOut(t, withMembers))) };
  });

  app.get("/Groups/:id", async (req) => groupOut(await loadTeam(pool, org(req), (req.params as { id: string }).id)));

  app.post("/Groups", async (req, reply) => {
    const orgId = org(req);
    const body = req.body as { displayName?: string; externalId?: string; members?: unknown };
    const name = body.displayName?.trim();
    if (!name) throw new ScimError(400, "displayName is required.", "invalidValue");
    const t = await withTx(async (c) => {
      let r;
      try {
        r = await c.query<TeamRow>("INSERT INTO teams (org_id, name, slug, scim_external_id) VALUES ($1,$2,$3,$4) RETURNING id, org_id, name, scim_external_id, created_at", [orgId, name.slice(0, 100), slug(name), body.externalId ?? null]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ScimError(409, "A team with that name exists.", "uniqueness");
        throw e;
      }
      await setMembers(c, orgId, r.rows[0]!.id, memberIds(body.members), []);
      await log(orgId, "scim.group.create", "team", r.rows[0]!.id, { name }, c);
      return r.rows[0]!;
    });
    return reply.code(201).header("location", `${base()}/Groups/${t.id}`).send(await groupOut(t));
  });

  app.patch("/Groups/:id", async (req) => {
    const orgId = org(req);
    const id = (req.params as { id: string }).id;
    const body = req.body as { Operations?: { op: string; path?: string; value?: unknown }[] };
    const t = await withTx(async (c) => {
      const team = await loadTeam(c, orgId, id);
      for (const op of body.Operations ?? []) {
        const kind = op.op.toLowerCase();
        const path = op.path ?? "";
        const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
        if (kind === "add" && (path.toLowerCase() === "members" || !path)) await setMembers(c, orgId, id, memberIds(path ? op.value : (op.value as { members?: unknown })?.members), []);
        else if (kind === "remove" && filtered) await setMembers(c, orgId, id, [], [filtered[1]!]);
        else if (kind === "remove" && path.toLowerCase() === "members") await setMembers(c, orgId, id, [], op.value ? memberIds(op.value) : "all");
        else if (kind === "replace" && path.toLowerCase() === "members") {
          await setMembers(c, orgId, id, [], "all");
          await setMembers(c, orgId, id, memberIds(op.value), []);
        } else if (kind === "replace" && (path.toLowerCase() === "displayname" || !path)) {
          const v = path ? op.value : (op.value as { displayName?: string })?.displayName;
          if (typeof v === "string" && v.trim()) await c.query("UPDATE teams SET name = $3, slug = $4 WHERE org_id = $1 AND id = $2", [orgId, id, v.trim().slice(0, 100), slug(v)]);
          const members = !path ? (op.value as { members?: unknown })?.members : undefined;
          if (members !== undefined) {
            await setMembers(c, orgId, id, [], "all");
            await setMembers(c, orgId, id, memberIds(members), []);
          }
        } else if (kind === "replace" && path.toLowerCase() === "externalid") await c.query("UPDATE teams SET scim_external_id = $3 WHERE org_id = $1 AND id = $2", [orgId, id, String(op.value)]);
        else throw new ScimError(400, `Operation ${op.op} ${path} is not supported on groups.`, "invalidSyntax");
      }
      await log(orgId, "scim.group.update", "team", id, { name: team.name, operations: (body.Operations ?? []).length }, c);
      return loadTeam(c, orgId, id);
    });
    return groupOut(t);
  });

  app.put("/Groups/:id", async (req) => {
    const orgId = org(req);
    const id = (req.params as { id: string }).id;
    const body = req.body as { displayName?: string; externalId?: string; members?: unknown };
    const t = await withTx(async (c) => {
      await loadTeam(c, orgId, id);
      if (body.displayName?.trim()) await c.query("UPDATE teams SET name = $3, slug = $4, scim_external_id = COALESCE($5, scim_external_id) WHERE org_id = $1 AND id = $2", [orgId, id, body.displayName.trim().slice(0, 100), slug(body.displayName), body.externalId ?? null]);
      await setMembers(c, orgId, id, [], "all");
      await setMembers(c, orgId, id, memberIds(body.members), []);
      await log(orgId, "scim.group.replace", "team", id, { name: body.displayName ?? null }, c);
      return loadTeam(c, orgId, id);
    });
    return groupOut(t);
  });

  app.delete("/Groups/:id", async (req, reply: FastifyReply) => {
    const orgId = org(req);
    const id = (req.params as { id: string }).id;
    const t = await loadTeam(pool, orgId, id);
    await pool.query("DELETE FROM teams WHERE org_id = $1 AND id = $2", [orgId, id]);
    await log(orgId, "scim.group.delete", "team", id, { name: t.name });
    return reply.code(204).send();
  });
}
