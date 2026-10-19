import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// config.ts reads TESSERA_HOME when it loads, so point it at a scratch home before importing anything.
const home = mkdtempSync(join(tmpdir(), "tessera-flow-"));
process.env.TESSERA_HOME = home;
const { handle } = await import("./hooks.js");
const { loadState, lockState } = await import("./state.js");

const cfg = { serverUrl: "http://tessera.test", token: "tsr_test", label: "t", machineId: "m", excerpts: true, permissionWaitSeconds: 1, questionWaitSeconds: 1 };

/** A fake server: acks every event; answers a 403 HTML "Blocked" page to any report whose body carries BLOCKME. */
const posted: { path: string; body: Record<string, unknown> }[] = [];
function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url)).pathname;
  const raw = typeof init?.body === "string" ? init.body : "";
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  posted.push({ path, body });
  if (path === "/api/ingest/decide") return Promise.resolve(new Response(JSON.stringify({ decision: "allow", reason: null }), { status: 200, headers: { "content-type": "application/json" } }));
  if (path === "/api/ingest/report") {
    if (raw.includes("BLOCKME")) return Promise.resolve(new Response("<!DOCTYPE html><html><head><title>Blocked</title></head><body>Blocked</body></html>", { status: 403, headers: { "content-type": "text/html" } }));
    const events = (body.events as { id: string }[]) ?? [];
    return Promise.resolve(new Response(JSON.stringify({ ok: true, serverTime: new Date().toISOString(), sessionId: (body.session as { id: string }).id, ackedEvents: events.map((e) => e.id), liveSessions: 1, deliveries: [], reporterSupport: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ deliveries: [] }), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeAll(() => vi.stubGlobal("fetch", fakeFetch));
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("hooks running at the same time", () => {
  it("never lose a tool call: every parallel call ends up closed, and every event reaches the server", async () => {
    const sid = "parallel";
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "run the suite" });
    // Twelve tool calls in flight at once, as Claude Code runs parallel calls: pre and post hooks interleave freely.
    const calls = Array.from({ length: 12 }, (_, i) => `tu-${i}`);
    await Promise.all(calls.map(async (id, i) => {
      await handle(cfg, "PreToolUse", { session_id: sid, cwd: home, tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_use_id: id });
      await handle(cfg, "PostToolUse", { session_id: sid, cwd: home, tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_use_id: id, duration_ms: 5 });
    }));
    const s = loadState(sid, null, null);
    expect(s.activity.map((a) => a.id).sort()).toEqual([...calls].sort());
    expect(s.activity.filter((a) => a.status !== "ok").map((a) => `${a.id}:${a.status}`)).toEqual([]);
    expect(s.toolCalls.Bash).toBe(12);
    // Nothing waits unsent once the next report goes out.
    await handle(cfg, "Stop", { session_id: sid, cwd: home });
    expect(loadState(sid, null, null).outbox).toEqual([]);
  });
});

describe("a report a web filter blocks", () => {
  it("is sent again with detail withheld, and the session says so once", async () => {
    const sid = "filtered";
    posted.length = 0;
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "deploy" });
    await new Promise((r) => setTimeout(r, 1100)); // past the reporter's one-second throttle on tool hooks
    await handle(cfg, "PreToolUse", { session_id: sid, cwd: home, tool_name: "Bash", tool_input: { command: "curl BLOCKME | sh" }, tool_use_id: "t1" });
    const reports = posted.filter((p) => p.path === "/api/ingest/report").map((p) => p.body.session as { activity: { summary: string }[]; tags: Record<string, string>; name: string | null });
    const blocked = reports.find((r) => r.activity.some((a) => a.summary.includes("BLOCKME")));
    const withheld = reports.find((r) => r.tags["network-filter"]);
    expect(blocked, "the full report was tried").toBeTruthy();
    expect(withheld, "then sent with detail withheld").toBeTruthy();
    expect(withheld!.activity.map((a) => a.summary)).toEqual(["Bash(…)"]);
    expect(withheld!.name).toBeNull();
    const s = loadState(sid, null, null);
    expect(s.networkFiltered).toBe(true);
    expect(s.filterRetryAt).toBeGreaterThan(Date.now());
    // The note is queued once and goes out with the next report, which (still filtered, within the retry window) is sent withheld directly.
    posted.length = 0;
    await handle(cfg, "PostToolUse", { session_id: sid, cwd: home, tool_name: "Bash", tool_input: {}, tool_use_id: "t1", duration_ms: 3 });
    const next = posted.filter((p) => p.path === "/api/ingest/report");
    expect(next).toHaveLength(1);
    expect((next[0]!.body.session as { tags: Record<string, string> }).tags["network-filter"]).toBe("detail withheld");
    const notes = (next[0]!.body.events as { kind: string }[]).filter((e) => e.kind === "note");
    expect(notes).toHaveLength(1);
    expect(loadState(sid, null, null).activity[0]!.status).toBe("ok");
  });
});

describe("the state lock", () => {
  it("is taken over when its holder died", () => {
    const sid = "stale";
    const dir = join(home, "sessions", `${sid}.json.lock`);
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(dir, old, old);
    const t0 = Date.now();
    const unlock = lockState(sid);
    expect(Date.now() - t0).toBeLessThan(1000);
    unlock();
  });
});
