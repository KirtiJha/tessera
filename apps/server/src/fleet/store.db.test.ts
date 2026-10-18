/**
 * Integration tests against a real PostgreSQL. They run when DATABASE_URL
 * points at a reachable database (CI provides one) and are skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { ingestOne, flushSamples, loadSession } from "./store.js";
import type { SessionRecord } from "./types.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const orgId = randomUUID();
const userId = randomUUID();

const rec = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
  orgId, id, teamId: null, ownerId: userId, ownerName: "T", deviceId: null, name: "t", reporterKind: "custom", reporterVersion: "0.1.0",
  hostname: "h", machineId: "m", cwd: null, model: "claude-sonnet-4-5", effort: null, status: "running", waitReason: null,
  startedAt: new Date().toISOString(), endedAt: null, endReason: null, lastSeenAt: new Date().toISOString(), droppedAt: null,
  contextUsed: null, contextWindow: null, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, usageByModel: [], ledgerCostUsd: null,
  blowouts: 0, git: null, filesChanged: [], plan: null, openAsk: null, tags: {}, continuedFrom: null,
  control: { paused: false, reason: null, by: null }, agents: [], ...over,
});

const agent = (id: string, status: "running" | "done" = "running") => ({
  id, parentId: null, kind: "subagent" as const, type: "Explore", description: null, model: "claude-haiku-4-5", effort: null, status,
  startedAt: new Date().toISOString(), endedAt: null, tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }, usageByModel: [],
  context: null, toolCalls: { Read: 2 }, skills: [], failure: null, promptExcerpt: null, answerExcerpt: null,
});
const ev = (id: string) => ({ id, ts: new Date().toISOString(), kind: "note" as const, agentId: null, text: `event ${id}` });

describe.skipIf(!reachable)("store against PostgreSQL", () => {
  beforeAll(async () => {
    await migrate(pool);
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Test', $2)", [orgId, `t-${orgId.slice(0, 8)}`]);
    await pool.query("INSERT INTO users (id, org_id, email, name, role) VALUES ($1, $2, $3, 'T', 'owner')", [userId, orgId, `t-${orgId}@test.local`]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("writes a brand-new session with its agents and events in one statement", async () => {
    const r = rec("s-new", { agents: [agent("a1"), agent("a2")] });
    const out = await ingestOne(pool, r, r.agents, [ev("e1"), ev("e2")]);
    expect(out.freshEventIds.sort()).toEqual(["e1", "e2"]);
    const back = await loadSession(orgId, "s-new");
    expect(back?.agents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("is idempotent for repeated events and updates only the agents passed", async () => {
    const r = rec("s-new", { agents: [agent("a1", "done"), agent("a2")] });
    const out = await ingestOne(pool, r, [r.agents[0]!], [ev("e2"), ev("e3")]);
    expect(out.freshEventIds).toEqual(["e3"]);
    const back = await loadSession(orgId, "s-new");
    expect(back?.agents.find((a) => a.id === "a1")?.status).toBe("done");
    const n = await pool.query("SELECT COUNT(*)::int AS n FROM events WHERE org_id = $1 AND session_id = 's-new'", [orgId]);
    expect(n.rows[0].n).toBe(3);
  });

  it("hands each queued delivery to exactly one report", async () => {
    await pool.query("INSERT INTO deliveries (org_id, session_id, kind, payload) VALUES ($1, 's-new', 'message', '{\"text\":\"hi\"}')", [orgId]);
    const [a, b] = await Promise.all([ingestOne(pool, rec("s-new"), [], []), ingestOne(pool, rec("s-new"), [], [])]);
    const all = [...a.deliveries, ...b.deliveries];
    expect(all).toHaveLength(1);
    expect(all[0]?.payload).toEqual({ text: "hi" });
    const again = await ingestOne(pool, rec("s-new"), [], []);
    expect(again.deliveries).toHaveLength(0);
  });

  it("adds sample deltas within a minute and skips rows for unknown sessions", async () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const row = { orgId, sessionId: "s-new", minute, tokensTotal: 100, tokensDelta: 40, costUsd: 0.5, usage: [] };
    await flushSamples(pool, [row, { ...row, sessionId: "does-not-exist" }]);
    await flushSamples(pool, [{ ...row, tokensTotal: 160, tokensDelta: 60, costUsd: 0.8 }]);
    const r = await pool.query("SELECT tokens_total, tokens_delta, cost_usd FROM samples WHERE org_id = $1 AND session_id = 's-new'", [orgId]);
    expect(r.rows).toEqual([{ tokens_total: 160, tokens_delta: 100, cost_usd: 0.8 }]);
  });
});
