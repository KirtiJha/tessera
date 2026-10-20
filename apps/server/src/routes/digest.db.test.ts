/**
 * Batch of things made from the daily spend rollup: the period comparison on
 * Analytics groups, the person and team pages, the weekly digest and the spend
 * alert, sent once to the channels that chose them.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { pool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");
const { hashPassword, encrypt } = await import("../auth/crypto.js");
const { isoWeek, lastWeek, runScheduled, spendAlerts, weeklyDigest } = await import("../notify/digest.js");
const { invalidateChannels } = await import("../notify/notifier.js");

describe("weeks", () => {
  it("names ISO weeks, and finds the Monday-to-Sunday week before a moment", () => {
    expect(isoWeek(Date.parse("2026-10-19T09:00:00Z"))).toBe("2026-W43");
    expect(isoWeek(Date.parse("2027-01-01T09:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-01-01T09:00:00Z"))).toBe("2026-W01");
    expect(lastWeek(Date.parse("2026-10-19T09:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18", label: "2026-W42" });
    expect(lastWeek(Date.parse("2026-10-21T23:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18", label: "2026-W42" });
  });
});

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}
const H = { "content-type": "application/json", "x-tessera-client": "web" };
const cookieFrom = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("tessera_session="))!.split(";")[0]!;
const log = { warn: () => {} };

describe.skipIf(!reachable)("digest, spend alerts, profiles and period comparison", () => {
  let app: FastifyInstance;
  let hook: Server;
  const got: { title: string; text: string; event: string; link: string }[] = [];
  const orgId = randomUUID();
  const sfx = orgId.slice(0, 6);
  let cookie = "";
  let ann = "";
  let bo = "";
  let pay = "";
  // A fixed Monday morning, far from today, so the global rollup never rewrites these days.
  const MONDAY = Date.parse("2026-03-16T09:30:00Z");
  const day = (offset: number) => new Date(MONDAY - offset * 86_400_000).toISOString().slice(0, 10);

  const session = (id: string, owner: string, team: string | null, repo: string, started: string, status = "ended") =>
    pool.query(
      `INSERT INTO sessions (org_id, id, team_id, owner_id, name, reporter_kind, reporter_version, status, started_at, model, git)
       VALUES ($1,$2,$3,$4,$2,'custom','0.1.0',$5,$6,'claude-sonnet-4-5',$7)`,
      [orgId, id, team, owner, status, started, JSON.stringify({ repo, branch: "main" })],
    );
  const spend = (id: string, d: string, cost: number) => pool.query("INSERT INTO usage_daily (org_id, session_id, day, tokens, cost_usd) VALUES ($1,$2,$3,1000,$4)", [orgId, id, d, cost]);

  beforeAll(async () => {
    await migrate(pool);
    hook = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (body) got.push(JSON.parse(body) as { title: string; text: string; event: string; link: string });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1,'Digest Co',$2)", [orgId, `digest-${sfx}`]);
    pay = (await pool.query<{ id: string }>("INSERT INTO teams (org_id, name, slug) VALUES ($1,'Payments','payments') RETURNING id", [orgId])).rows[0]!.id;
    const pw = await hashPassword("password-12345");
    ann = (await pool.query<{ id: string }>("INSERT INTO users (org_id, team_id, email, name, role, password_hash) VALUES ($1,$2,$3,'Ann','admin',$4) RETURNING id", [orgId, pay, `ann-${sfx}@digest.test`, pw])).rows[0]!.id;
    bo = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Bo','operator',$3) RETURNING id", [orgId, `bo-${sfx}@digest.test`, pw])).rows[0]!.id;
    cookie = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `ann-${sfx}@digest.test`, password: "password-12345" } }));
    // Three weeks of steady spend by Ann on payments, about $10 a day; Bo a little on the platform.
    for (let i = 1; i <= 21; i++) {
      const id = `d-${sfx}-a${i}`;
      await session(id, ann, pay, "acme/payments", `${day(i)}T10:00:00Z`);
      await spend(id, day(i), 10 + (i % 3));
    }
    for (let i = 1; i <= 7; i++) {
      const id = `d-${sfx}-b${i}`;
      await session(id, bo, null, "acme/platform", `${day(i)}T11:00:00Z`);
      await spend(id, day(i), 2);
    }
    // A prompt in last week that Ann answered in Tessera after two minutes.
    await pool.query("INSERT INTO asks (org_id, session_id, id, kind, tool, prompt, created_at, closed_at, outcome, answered_by) VALUES ($1,$2,'q1','permission','Bash','Bash(x)',$3,$4,'answered',$5)", [orgId, `d-${sfx}-a2`, `${day(2)}T10:05:00Z`, `${day(2)}T10:07:00Z`, ann]);
    await pool.query(
      "INSERT INTO notification_channels (org_id, kind, name, url_enc, events) VALUES ($1,'webhook','Digest hook',$2,$3)",
      [orgId, encrypt(`http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`), JSON.stringify(["digest.weekly", "spend.anomaly"])],
    );
    invalidateChannels(orgId);
  });

  afterAll(async () => {
    await app.close();
    hook.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("sums up last week against the week before, with teams, the costliest sessions and the prompts", async () => {
    const n = await weeklyDigest(orgId, MONDAY);
    expect(n.dedupeKey).toBe("digest:2026-W11");
    expect(n.title).toMatch(/^Tessera week W11: \$\d+\.\d\d \([+−]\d+%\)$/);
    expect(n.text).toMatch(/^14 sessions by 2 people cost \$/);
    expect(n.text).toContain("Teams: Payments $");
    expect(n.text).toContain("1 prompt waited on people, 1 answered in Tessera; half were settled within 2 min.");
    expect(n.path).toBe("/app/analytics?from=2026-03-09&to=2026-03-15");
  });

  it("sends the digest once on Monday morning to the channels that chose it, and not on other days", async () => {
    got.length = 0;
    await runScheduled(log, MONDAY - 86_400_000); // Sunday: no digest
    expect(got.filter((g) => g.event === "digest.weekly")).toEqual([]);
    await runScheduled(log, MONDAY);
    await runScheduled(log, MONDAY + 3600_000);
    const digests = got.filter((g) => g.event === "digest.weekly");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.link).toMatch(/\/app\/analytics\?from=2026-03-09&to=2026-03-15$/);
  });

  it("alerts once when a day's spend is far above the two weeks before, for the team and the organisation", async () => {
    const spike = `d-${sfx}-spike`;
    await session(spike, ann, pay, "acme/payments", `${day(0)}T08:00:00Z`, "running");
    await spend(spike, day(0), 120);
    const alerts = await spendAlerts(orgId, MONDAY);
    expect(alerts.map((a) => a.dedupeKey).sort()).toEqual([`anomaly:org:${day(0)}`, `anomaly:team:${pay}:${day(0)}`].sort());
    const team = alerts.find((a) => a.dedupeKey.startsWith("anomaly:team"))!;
    expect(team.title).toMatch(/^Payments spent \$1\d\d\.\d\d so far today$/);
    expect(team.path).toBe(`/app/teams/${pay}`);
    got.length = 0;
    await runScheduled(log, MONDAY + 60_000);
    await runScheduled(log, MONDAY + 120_000);
    expect(got.filter((g) => g.event === "spend.anomaly")).toHaveLength(2);
  });

  it("shows a team's members and spend against the period before, and a person's prompts", async () => {
    const team = (await app.inject({ method: "GET", url: `/api/analytics/profile/team/${pay}?from=${day(7)}&to=${day(1)}`, headers: { ...H, cookie } })).json();
    expect(team.subject).toMatchObject({ kind: "team", name: "Payments", members: 1 });
    expect(team.members.map((m: { name: string }) => m.name)).toEqual(["Ann"]);
    expect(team.repos[0].repo).toBe("acme/payments");
    expect(team.totals.costUsd).toBeGreaterThan(60);
    expect(team.totals.prevCostUsd).toBeGreaterThan(60);
    expect(team.daily).toHaveLength(7);
    const person = (await app.inject({ method: "GET", url: `/api/analytics/profile/person/${bo}?days=30`, headers: { ...H, cookie } })).json();
    expect(person.subject).toMatchObject({ kind: "person", name: "Bo", team: null });
    expect(person.recent.length).toBeGreaterThan(0);
    const ann30 = (await app.inject({ method: "GET", url: `/api/analytics/profile/person/${ann}?from=${day(7)}&to=${day(1)}`, headers: { ...H, cookie } })).json();
    expect(ann30.prompts.answered).toMatchObject({ count: 1, p50Ms: 120_000 });
    expect((await app.inject({ method: "GET", url: `/api/analytics/profile/team/${randomUUID()}`, headers: { ...H, cookie } })).statusCode).toBe(404);
  });

  it("gives each Analytics group its id and its spend in the period before", async () => {
    const r = (await app.inject({ method: "GET", url: `/api/analytics?from=${day(7)}&to=${day(1)}&groupBy=team`, headers: { ...H, cookie } })).json();
    const g = r.groups.find((x: { key: string }) => x.key === "Payments");
    expect(g.id).toBe(pay);
    expect(g.prevCostUsd).toBeGreaterThan(60);
    const people = (await app.inject({ method: "GET", url: `/api/analytics?from=${day(7)}&to=${day(1)}&groupBy=person`, headers: { ...H, cookie } })).json();
    expect(people.groups.find((x: { key: string }) => x.key === "Bo")).toMatchObject({ id: bo, prevCostUsd: 0 });
  });

  it("sends last week's digest to one channel on request", async () => {
    const ch = (await pool.query<{ id: string }>("SELECT id FROM notification_channels WHERE org_id = $1", [orgId])).rows[0]!.id;
    got.length = 0;
    const r = await app.inject({ method: "POST", url: `/api/admin/channels/${ch}/digest`, headers: { ...H, cookie }, payload: {} });
    expect(r.json().error).toBeNull();
    expect(got.map((g) => g.event)).toEqual(["digest.weekly"]);
  });
});
