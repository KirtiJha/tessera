/**
 * Spend analytics and chargeback: the daily rollup from per-minute samples,
 * allocation by team, cost centre, ticket and tag, and the CSV export.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { rollupDays } from "../fleet/rollup.js";
import { anomalies, toCsv } from "./analytics.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;

describe("analytics helpers", () => {
  it("flags a day far above the trailing fortnight", () => {
    const days = Array.from({ length: 20 }, (_, i) => ({ day: `d${i}`, costUsd: 10 + (i % 2) }));
    days[15]!.costUsd = 60;
    expect([...anomalies(days)]).toEqual(["d15"]);
  });
  it("writes CSV that spreadsheets will not execute", () => {
    expect(toCsv([["name", "cost"], ['=HYPERLINK("http://x")', 1], ["a,b", -2]])).toBe('name,cost\r\n"\'=HYPERLINK(""http://x"")",1\r\n"a,b",\'-2\r\n');
  });
});

describe.skipIf(!reachable)("spend analytics", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let admin = "";
  let viewer = "";
  const teams: Record<string, string> = {};

  const session = async (id: string, team: string | null, owner: string, branch: string, tags: Record<string, string>, name = id) =>
    pool.query(
      `INSERT INTO sessions (org_id, id, team_id, owner_id, name, reporter_kind, reporter_version, status, started_at, model, git, tags)
       VALUES ($1,$2,$3,$4,$5,'custom','0.1.0','ended','2026-09-09T22:00:00Z','claude-sonnet-4-5',$6,$7)`,
      [orgId, id, team, owner, name, JSON.stringify({ repo: "acme/payments", branch }), JSON.stringify(tags)],
    );
  const sample = (id: string, ts: string, total: number, cost: number) =>
    pool.query("INSERT INTO samples (org_id, session_id, ts, tokens_total, tokens_delta, cost_usd) VALUES ($1,$2,$3,$4,$4,$5)", [orgId, id, ts, total, cost]);

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Spend Co', $2)", [orgId, `spend-${sfx}`]);
    for (const [name, cc] of [["Payments", "CC-120"], ["Platform", null]] as const) {
      const r = await pool.query<{ id: string }>("INSERT INTO teams (org_id, name, slug, cost_center) VALUES ($1,$2,$3,$4) RETURNING id", [orgId, name, name.toLowerCase(), cc]);
      teams[name] = r.rows[0]!.id;
    }
    const pw = await hashPassword("password-12345");
    const u = await pool.query<{ id: string; role: string }>(
      "INSERT INTO users (org_id, email, name, role, password_hash, team_id) VALUES ($1,$2,'Ada','admin',$4,$5), ($1,$3,'Vic','viewer',$4,NULL) RETURNING id, role",
      [orgId, `ada-${sfx}@spend.test`, `vic-${sfx}@spend.test`, pw, teams.Payments],
    );
    const ada = u.rows.find((r) => r.role === "admin")!.id;
    admin = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ada-${sfx}@spend.test`, password: "password-12345" } }));
    viewer = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `vic-${sfx}@spend.test`, password: "password-12345" } }));

    // s1: Payments, ticket in the branch, spans two days ($2 on the 10th, $3 on the 11th).
    await session("s1", teams.Payments!, ada, "feat/PAY-142-refunds", { project: "apollo" }, "=cmd|'/c calc'!A1");
    await sample("s1", "2026-09-10T10:00:00Z", 100, 0.5);
    await sample("s1", "2026-09-10T23:59:00Z", 400, 2);
    await sample("s1", "2026-09-11T00:01:00Z", 500, 2.5);
    await sample("s1", "2026-09-11T09:00:00Z", 900, 5);
    // s2: Platform, no cost centre, ticket from a tag; a sample from long before the window.
    await session("s2", teams.Platform!, ada, "main", { ticket: "OPS-7" });
    await sample("s2", "2026-09-05T12:00:00Z", 1000, 10);
    await sample("s2", "2026-09-11T12:00:00Z", 1500, 14);
    await rollupDays("2026-09-10", "2026-09-12");
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("rolls cumulative samples up into each day's rise", async () => {
    const r = await pool.query("SELECT session_id, to_char(day, 'YYYY-MM-DD') AS day, tokens::int, cost_usd::float AS cost FROM usage_daily WHERE org_id = $1 ORDER BY 1, 2", [orgId]);
    expect(r.rows).toEqual([
      { session_id: "s1", day: "2026-09-10", tokens: 500, cost: 2 },
      { session_id: "s1", day: "2026-09-11", tokens: 1400, cost: 3 },
      // Measured from the last sample before the window, not from zero.
      { session_id: "s2", day: "2026-09-11", tokens: 1500, cost: 4 },
    ]);
    // Rewriting is idempotent.
    await rollupDays("2026-09-10", "2026-09-12");
    const again = await pool.query("SELECT SUM(cost_usd)::float AS c FROM usage_daily WHERE org_id = $1", [orgId]);
    expect(again.rows[0]!.c).toBe(9);
  });

  it("totals and groups by team, cost centre, ticket and tag", async () => {
    const get = async (groupBy: string) => (await app.inject({ method: "GET", url: `/api/analytics?from=2026-09-10&to=2026-09-12&groupBy=${encodeURIComponent(groupBy)}`, headers: { cookie: viewer } })).json();
    const team = await get("team");
    expect(team.totals).toMatchObject({ costUsd: 9, sessions: 2, people: 1 });
    expect(team.daily.map((d: { day: string; costUsd: number }) => [d.day, d.costUsd])).toEqual([["2026-09-10", 2], ["2026-09-11", 7], ["2026-09-12", 0]]);
    expect(team.groups.map((g: { key: string; costUsd: number }) => [g.key, g.costUsd])).toEqual([["Payments", 5], ["Platform", 4]]);
    expect((await get("cost_center")).groups.map((g: { key: string }) => g.key)).toEqual(["CC-120", "Unallocated"]);
    expect((await get("ticket")).groups.map((g: { key: string }) => g.key)).toEqual(["PAY-142", "OPS-7"]);
    expect((await get("tag:project")).groups.map((g: { key: string }) => g.key)).toEqual(["apollo", "Untagged"]);
    const one = (await app.inject({ method: "GET", url: `/api/analytics?from=2026-09-10&to=2026-09-12&team=${teams.Platform}`, headers: { cookie: viewer } })).json();
    expect(one.totals.costUsd).toBe(4);
  });

  it("exports chargeback CSV for admins only, safe to open in a spreadsheet", async () => {
    expect((await app.inject({ method: "GET", url: "/api/analytics/export.csv?from=2026-09-10&to=2026-09-12", headers: { cookie: viewer } })).statusCode).toBe(403);
    const g = await app.inject({ method: "GET", url: "/api/analytics/export.csv?from=2026-09-10&to=2026-09-12&groupBy=cost_center", headers: { cookie: admin } });
    expect(g.headers["content-type"]).toContain("text/csv");
    expect(g.body).toBe("cost_center,sessions,people,tokens,cost_usd\r\nCC-120,1,1,1900,5.0000\r\nUnallocated,1,1,1500,4.0000\r\n");
    const s = await app.inject({ method: "GET", url: "/api/analytics/export.csv?from=2026-09-10&to=2026-09-12&detail=sessions", headers: { cookie: admin } });
    const lines = s.body.trim().split("\r\n");
    expect(lines[0]).toBe("session_id,name,started_at,ended_at,person,email,team,cost_center,repository,branch,ticket,model,tags,tokens,cost_usd");
    expect(lines[1]).toContain(`s1,'=cmd|'/c calc'!A1,`);
    expect(lines[1]).toContain(",Payments,CC-120,acme/payments,feat/PAY-142-refunds,PAY-142,claude-sonnet-4-5,project=apollo,1900,5.0000");
    const a = await pool.query("SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'spend.export' ORDER BY id", [orgId]);
    expect(a.rows.map((r) => r.detail.detail)).toEqual(["groups", "sessions"]);
  });

  it("validates allocation settings", async () => {
    const bad = await app.inject({ method: "PUT", url: "/api/analytics/settings", headers: { ...H, cookie: admin }, payload: { ticketPattern: "([A-Z" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/analytics/settings", headers: { ...H, cookie: admin }, payload: { ticketPattern: "#[0-9]+", costCenters: [{ teamId: teams.Platform, costCenter: "CC-200" }] } });
    expect(ok.statusCode).toBe(200);
    const s = (await app.inject({ method: "GET", url: "/api/analytics/settings", headers: { cookie: viewer } })).json();
    expect(s.ticketPattern).toBe("#[0-9]+");
    expect(s.teams.find((t: { name: string }) => t.name === "Platform").costCenter).toBe("CC-200");
    expect(s.tagKeys).toEqual(["project", "ticket"]);
  });
});
