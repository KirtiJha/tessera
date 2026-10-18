/**
 * Data handling: metadata-only mode and DLP at the edge, retention per
 * organisation and legal hold, audit export and streaming, a person's export
 * and erasure.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/crypto.js";
import { issueDevice } from "../auth/devices.js";
import { prune } from "../fleet/store.js";
import { pumpAuditStreams } from "../compliance/stream.js";

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

describe.skipIf(!reachable)("data handling", () => {
  let app: FastifyInstance;
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const sfx = orgId.slice(0, 6);
  let owner = "";
  let opId = "";
  let token = "";
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let failNext = false;
  const siem = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (failNext) {
        failNext = false;
        return res.writeHead(503).end();
      }
      received.push({ headers: req.headers, body: b });
      res.writeHead(200).end("{}");
    });
  });

  const ingest = (sid: string, extra: Record<string, unknown>, events: unknown[] = []) =>
    app.inject({
      method: "POST", url: "/api/ingest/report", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { v: 1, sentAt: new Date().toISOString(), reporter: { kind: "custom", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" }, session: { id: sid, status: "running", startedAt: new Date().toISOString(), ...extra }, events },
    });

  beforeAll(async () => {
    await new Promise<void>((r) => siem.listen(0, "127.0.0.1", r));
    await migrate(pool);
    const { buildApp } = await import("../app.js");
    app = (await buildApp()).server;
    await app.ready();
    await pool.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Data Co', $2), ($3, 'Other Data Co', $4)", [orgId, `data-${sfx}`, otherOrg, `odata-${sfx}`]);
    const pw = await hashPassword("password-12345");
    await pool.query("INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,'Olive Owner','owner',$3)", [orgId, `owner-${sfx}@data.test`, pw]);
    opId = (await pool.query<{ id: string }>("INSERT INTO users (org_id, email, name, role) VALUES ($1,$2,'Oscar Op','operator') RETURNING id", [orgId, `op-${sfx}@data.test`])).rows[0]!.id;
    owner = cookieFrom(await app.inject({ method: "POST", url: "/api/auth/signin", headers: H, payload: { email: `owner-${sfx}@data.test`, password: "password-12345" } }));
    token = (await issueDevice(orgId, opId, "laptop")).token;
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[orgId, otherOrg]]);
    await pool.end();
    siem.close();
  });

  it("keeps prompt text out in metadata-only mode and removes the DLP classes chosen", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/admin/data/settings", headers: { ...H, cookie: owner }, payload: { excerpts: false, dlp: { emails: true, cards: true, terms: ["Project Falcon"] } } });
    expect(put.statusCode).toBe(200);
    await ingest(`m-${sfx}`, {
      name: "email ann@client.com the report",
      status: "waiting", waitReason: "permission",
      openAsk: { id: "a1", kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(charge 4111 1111 1111 1111 for Project Falcon)" },
      agents: [{ id: "g1", kind: "subagent", status: "running", startedAt: new Date().toISOString(), promptExcerpt: "find ann@client.com", answerExcerpt: "done" }],
    }, [{ id: "e1", ts: new Date().toISOString(), kind: "turn.start", text: "prompt: deploy Project Falcon for ann@client.com" }, { id: "e2", ts: new Date().toISOString(), kind: "note", text: "mail sent to ann@client.com" }]);
    const s = await pool.query("SELECT name, open_ask FROM sessions WHERE org_id = $1 AND id = $2", [orgId, `m-${sfx}`]);
    expect(s.rows[0].name).toBeNull();
    expect(s.rows[0].open_ask.prompt).toBe("Bash(charge [card] for [term])");
    const a = await pool.query("SELECT prompt_excerpt, answer_excerpt FROM agents WHERE org_id = $1 AND session_id = $2", [orgId, `m-${sfx}`]);
    expect(a.rows[0]).toEqual({ prompt_excerpt: null, answer_excerpt: null });
    const e = await pool.query("SELECT id, text FROM events WHERE org_id = $1 AND session_id = $2 ORDER BY id", [orgId, `m-${sfx}`]);
    expect(e.rows.map((r) => r.text)).toEqual(["prompt submitted", "mail sent to [email]"]);
  });

  it("prunes per organisation, and not at all under legal hold", async () => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    for (const [org, sid] of [[orgId, `p-${sfx}`], [otherOrg, `q-${sfx}`]] as const) {
      await pool.query("INSERT INTO sessions (org_id, id, reporter_kind, reporter_version, status, started_at) VALUES ($1,$2,'custom','0.1.0','running',now())", [org, sid]);
      await pool.query("INSERT INTO events (org_id, session_id, id, ts, kind, text) VALUES ($1,$2,'old',$3,'note','old')", [org, sid, old]);
    }
    await pool.query("UPDATE orgs SET settings = jsonb_set(settings, '{data,retainEventsDays}', '1') WHERE id = $1", [orgId]);
    await prune(30, 180, 365);
    const left = await pool.query("SELECT org_id FROM events WHERE id = 'old' AND org_id = ANY($1)", [[orgId, otherOrg]]);
    expect(left.rows.map((r) => r.org_id)).toEqual([otherOrg]);

    expect((await app.inject({ method: "POST", url: "/api/admin/data/legal-hold", headers: { ...H, cookie: owner }, payload: { on: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/data/legal-hold", headers: { ...H, cookie: owner }, payload: { on: true, reason: "Matter 2026-114" } })).statusCode).toBe(200);
    await pool.query("INSERT INTO events (org_id, session_id, id, ts, kind, text) VALUES ($1,$2,'old2',$3,'note','old')", [orgId, `p-${sfx}`, old]);
    await prune(30, 180, 365);
    expect((await pool.query("SELECT 1 FROM events WHERE org_id = $1 AND id = 'old2'", [orgId])).rowCount).toBe(1);
    const er = await app.inject({ method: "POST", url: `/api/admin/data/people/${opId}/erase`, headers: { ...H, cookie: owner }, payload: { confirm: `op-${sfx}@data.test` } });
    expect(er.statusCode).toBe(409);
    expect(er.json().error).toContain("legal hold");
    await app.inject({ method: "POST", url: "/api/admin/data/legal-hold", headers: { ...H, cookie: owner }, payload: { on: false } });
  });

  it("exports the audit log with its hash chain", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/data/audit/export?format=jsonl", headers: { cookie: owner } });
    const lines = r.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[0].prevHash).toBeNull();
    for (let i = 1; i < lines.length; i++) expect(lines[i].prevHash).toBe(lines[i - 1].hash);
    const csv = await app.inject({ method: "GET", url: "/api/admin/data/audit/export?format=csv", headers: { cookie: owner } });
    expect(csv.body.split("\r\n")[0]).toBe("id,time,actor,action,target_type,target_id,detail,ip,prev_hash,hash");
  });

  it("streams new audit entries to a SIEM in order, retrying after a failure", async () => {
    const url = `http://127.0.0.1:${(siem.address() as AddressInfo).port}/hec`;
    expect((await app.inject({ method: "PUT", url: "/api/admin/data/audit/stream", headers: { ...H, cookie: owner }, payload: { url, format: "splunk_hec", headerName: "Authorization", headerValue: "Splunk hec-token-123" } })).statusCode).toBe(200);
    received.length = 0;
    await app.inject({ method: "POST", url: "/api/admin/data/legal-hold", headers: { ...H, cookie: owner }, payload: { on: false } });
    failNext = true;
    await pumpAuditStreams(log);
    expect(received).toHaveLength(0);
    expect((await pool.query("SELECT last_error FROM audit_streams WHERE org_id = $1", [orgId])).rows[0].last_error).toBe("HTTP 503");
    await pumpAuditStreams(log);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe("Splunk hec-token-123");
    const events = received[0]!.body.split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.event.action)).toEqual(["audit.stream.update", "data.hold.off"]);
    expect(events[0].sourcetype).toBe("tessera:audit");
    await pumpAuditStreams(log);
    expect(received).toHaveLength(1);
    const g = (await app.inject({ method: "GET", url: "/api/admin/data", headers: { cookie: owner } })).json();
    expect(g.stream).toMatchObject({ format: "splunk_hec", pending: 0, lastError: null });
    expect(JSON.stringify(g)).not.toContain("hec-token-123");
  });

  it("exports a person's data, then erases it on confirmation", async () => {
    const ex = await app.inject({ method: "GET", url: `/api/admin/data/people/${opId}/export`, headers: { cookie: owner } });
    expect(ex.json().sessions.map((s: { id: string }) => s.id)).toContain(`m-${sfx}`);
    expect((await app.inject({ method: "POST", url: `/api/admin/data/people/${opId}/erase`, headers: { ...H, cookie: owner }, payload: { confirm: "wrong@x.test" } })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: `/api/admin/data/people/${opId}/erase`, headers: { ...H, cookie: owner }, payload: { confirm: `OP-${sfx}@data.test` } });
    expect(r.json()).toMatchObject({ ok: true, devices: 1 });
    expect(r.json().sessions).toBeGreaterThanOrEqual(1);
    const u = await pool.query("SELECT name, email, status, erased_at FROM users WHERE id = $1", [opId]);
    expect(u.rows[0]).toMatchObject({ name: "Erased person", email: `erased-${opId}@erased.invalid`, status: "disabled" });
    expect((await pool.query("SELECT 1 FROM sessions WHERE org_id = $1 AND owner_id = $2", [orgId, opId])).rowCount).toBe(0);
    // The device stops at once, even though it was used (and cached) moments ago.
    expect((await ingest(`z-${sfx}`, {})).statusCode).toBe(401);
    const v = await app.inject({ method: "GET", url: "/api/admin/audit/verify", headers: { cookie: owner } });
    expect(v.json().ok).toBe(true);
  });
});
