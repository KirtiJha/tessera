/**
 * OpenTelemetry ingest: a runtime that exports GenAI-convention traces shows
 * up as a session with agents, tokens per model and failed tool calls.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { issueDevice } from "../auth/devices.js";
import { foldTraces, OtlpSession } from "../fleet/otlp.js";

let reachable = false;
try {
  await pool.query("SELECT 1");
  reachable = true;
} catch {
  reachable = false;
}

const hex = (n: number) => randomBytes(n).toString("hex");
const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });
const nano = (msAgo: number) => String(BigInt(Date.now() - msAgo) * 1_000_000n);

function span(o: { id: string; parent?: string; trace: string; name: string; attrs: Record<string, { stringValue?: string; intValue?: string }>; start: number; end: number; error?: string }) {
  return {
    traceId: o.trace, spanId: o.id, parentSpanId: o.parent ?? "", name: o.name,
    startTimeUnixNano: nano(o.start), endTimeUnixNano: nano(o.end),
    attributes: Object.entries(o.attrs).map(([key, value]) => ({ key, value })),
    status: o.error ? { code: 2, message: o.error } : { code: 0 },
  };
}
const envelope = (spans: unknown[], sessionId: string) => ({
  resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: s("codex-cli") }, { key: "service.version", value: s("0.50.0") }, { key: "host.name", value: s("build-07") }, { key: "session.id", value: s(sessionId) }] },
    scopeSpans: [{ scope: { name: "agent" }, spans }],
  }],
});

describe("OTLP folding", () => {
  it("re-homes a child's tokens to its agent when the agent span arrives later", () => {
    const sessions = new Map<string, OtlpSession>();
    const t = hex(16);
    const [root, agent, chat] = [hex(8), hex(8), hex(8)];
    foldTraces(envelope([span({ id: chat, parent: agent, trace: t, name: "chat", attrs: { "gen_ai.operation.name": s("chat"), "gen_ai.request.model": s("gpt-5-codex"), "gen_ai.usage.input_tokens": i(1000), "gen_ai.usage.output_tokens": i(200) }, start: 5000, end: 4000 })], "x"), sessions);
    expect(sessions.get("x")!.report().session.usageByModel).toEqual([{ model: "gpt-5-codex", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }]);
    foldTraces(envelope([span({ id: agent, parent: root, trace: t, name: "invoke_agent reviewer", attrs: { "gen_ai.operation.name": s("invoke_agent"), "gen_ai.agent.name": s("reviewer") }, start: 6000, end: 3000 })], "x"), sessions);
    const r = sessions.get("x")!.report();
    expect(r.session.usageByModel).toEqual([]);
    expect(r.session.agents[0]).toMatchObject({ type: "reviewer", status: "done", usageByModel: [{ model: "gpt-5-codex", input: 1000, output: 200 }] });
    expect(r.reporter.kind).toBe("codex-cli");
  });
});

describe.skipIf(!reachable)("OTLP ingest", () => {
  let app: FastifyInstance;
  let fleet: import("../fleet/fleet.js").Fleet;
  const orgId = randomUUID();
  let token = "";
  const sid = `otlp-${orgId.slice(0, 6)}`;
  const trace = hex(16);
  const ids = { root: hex(8), agent: hex(8), chat1: hex(8), chat2: hex(8), tool: hex(8) };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/ingest/otlp/v1/traces", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, payload: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) });

  beforeAll(async () => {
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    const built = await buildApp();
    app = built.server;
    fleet = built.fleet;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'OTLP Co', $2)", [orgId, `otlp-${orgId.slice(0, 8)}`]);
    const u = await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, 'Ola', 'operator') RETURNING id", [orgId, `ola-${orgId.slice(0, 6)}@otlp.test`]);
    token = (await issueDevice(orgId, u.rows[0]!.id, "build-07")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = $1", [orgId]);
    await pool.end();
  });

  it("puts a runtime's session on the wall from its spans, gzipped or not", async () => {
    const batch1 = envelope([
      span({ id: ids.chat1, parent: ids.root, trace, name: "chat", attrs: { "gen_ai.operation.name": s("chat"), "gen_ai.request.model": s("claude-sonnet-4-5"), "gen_ai.usage.input_tokens": i(2000), "gen_ai.usage.output_tokens": i(300), "vcs.repository.url.full": s("git@github.com:acme/payments.git"), "vcs.ref.head.name": s("feat/refunds") }, start: 9000, end: 8000 }),
      span({ id: ids.tool, parent: ids.agent, trace, name: "execute_tool Bash", attrs: { "gen_ai.operation.name": s("execute_tool"), "gen_ai.tool.name": s("Bash") }, start: 7000, end: 6500, error: "exit 1: tests failed" }),
      span({ id: ids.chat2, parent: ids.agent, trace, name: "chat", attrs: { "gen_ai.operation.name": s("chat"), "gen_ai.request.model": s("claude-haiku-4-5"), "gen_ai.usage.input_tokens": i(500), "gen_ai.usage.output_tokens": i(50), "gen_ai.usage.cache_read.input_tokens": i(4000) }, start: 6400, end: 6000 }),
    ], sid);
    const r1 = await post(gzipSync(Buffer.from(JSON.stringify(batch1))), { "content-encoding": "gzip" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ partialSuccess: {} });
    const batch2 = envelope([span({ id: ids.agent, parent: ids.root, trace, name: "invoke_agent tester", attrs: { "gen_ai.operation.name": s("invoke_agent"), "gen_ai.agent.name": s("tester") }, start: 7500, end: 5000, error: "could not make tests pass" })], sid);
    expect((await post(batch2)).statusCode).toBe(200);
    // An exporter retry of the same spans changes nothing.
    await post(batch1);

    const rec = fleet.get(orgId, sid)!;
    expect(rec).toBeTruthy();
    expect(rec.reporterKind).toBe("codex-cli");
    expect(rec.hostname).toBe("build-07");
    expect(rec.git).toMatchObject({ repo: "acme/payments", branch: "feat/refunds" });
    expect(rec.usageByModel).toEqual([{ model: "claude-sonnet-4-5", input: 2000, output: 300, cacheRead: 0, cacheWrite: 0 }]);
    expect(rec.agents).toHaveLength(1);
    expect(rec.agents[0]).toMatchObject({ type: "tester", status: "failed", toolCalls: { Bash: 1 }, usageByModel: [{ model: "claude-haiku-4-5", input: 500, output: 50, cacheRead: 4000, cacheWrite: 0 }] });
    const view = (await fleet.views(orgId))[0]!;
    // The session's cost includes its agent's.
    const alone = 2000 * 3 / 1e6 + 300 * 15 / 1e6;
    expect(view.costUsd!).toBeGreaterThan(alone);
    const ev = await pool.query("SELECT kind, text FROM events WHERE org_id = $1 AND session_id = $2 ORDER BY ts", [orgId, sid]);
    expect(ev.rows.map((e) => e.kind)).toEqual(expect.arrayContaining(["tool.fail", "agent.spawn", "agent.fail"]));
    expect(ev.rows.find((e) => e.kind === "tool.fail")!.text).toBe("Bash failed: exit 1: tests failed");
  });

  it("refuses protobuf with a hint, and anything without a device token", async () => {
    const pb = await post("x", { "content-type": "application/x-protobuf" });
    expect(pb.statusCode).toBe(415);
    expect(pb.json().error).toContain("http/json");
    const anon = await app.inject({ method: "POST", url: "/api/ingest/otlp/v1/traces", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(anon.statusCode).toBe(401);
  });
});
