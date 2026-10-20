import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reads TESSERA_HOME when it loads, so point it at a scratch home before importing anything.
const home = mkdtempSync(join(tmpdir(), "tessera-mod-"));
process.env.TESSERA_HOME = home;
const { handle } = await import("./hooks.js");
const { loadState } = await import("./state.js");
const { buildReport } = await import("./transport.js");
const { claudeLoadsMods, disableMod, enableMod, modInstalled, writeMod, MOD_DIR, PLUGIN_ID } = await import("./mod.js");

const cfg = { serverUrl: "http://tessera.test", token: "tsr_test", label: "t", machineId: "m", excerpts: true, permissionWaitSeconds: 2, questionWaitSeconds: 1 };

type Delivery = { id: string; kind: "answer" | "message" | "command"; askId: string | null; payload: Record<string, unknown> };
/** Deliveries the fake server hands to the next report that claims them, as the real one does. */
let queued: Delivery[] = [];
const results: { id: string; body: unknown }[] = [];
const reports: Record<string, unknown>[] = [];

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}
function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  if (u.pathname === "/api/ingest/decide") return json({ decision: "allow", reason: null });
  if (u.pathname === "/api/ingest/report") {
    reports.push(body);
    const claim = body.claimDeliveries !== false;
    const deliveries = claim ? queued : [];
    if (claim) queued = [];
    const events = (body.events as { id: string }[]) ?? [];
    return json({ ok: true, serverTime: new Date().toISOString(), sessionId: (body.session as { id: string }).id, ackedEvents: events.map((e) => e.id), liveSessions: 1, deliveries, reporterSupport: "ok" });
  }
  const m = /^\/api\/ingest\/deliveries\/([^/]+)\/result$/.exec(u.pathname);
  if (m) {
    results.push({ id: m[1]!, body });
    return json({ ok: true });
  }
  if (u.pathname.endsWith("/deliveries")) {
    // The real server holds a long poll open; answering at once would spin the waiting hook.
    return new Promise((r) => setTimeout(r, 100)).then(() => {
      const d = queued;
      queued = [];
      return json({ deliveries: d });
    });
  }
  return json({});
}

beforeAll(() => vi.stubGlobal("fetch", fakeFetch));
beforeEach(() => {
  queued = [];
  results.length = 0;
  reports.length = 0;
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("deliveries a report claims for another hook", () => {
  it("a message claimed by a tool hook's report is delivered when the turn ends", async () => {
    const sid = "msg-mid-turn";
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "refactor" });
    // Sent from the console while a tool runs: the PostToolUse report claims it, and cannot act on it.
    queued = [{ id: "m-1", kind: "message", askId: null, payload: { text: "stop after this file", by: "Raj" } }];
    await handle(cfg, "PreToolUse", { session_id: sid, cwd: home, tool_name: "Read", tool_input: { file_path: "/r/a.ts" }, tool_use_id: "r1" });
    await new Promise((r) => setTimeout(r, 1100)); // past the one-second throttle on tool hooks
    await handle(cfg, "PostToolUse", { session_id: sid, cwd: home, tool_name: "Read", tool_input: { file_path: "/r/a.ts" }, tool_use_id: "r1", duration_ms: 2 });
    expect(queued, "the tool hook's report claimed it").toEqual([]);
    const stop = await handle(cfg, "Stop", { session_id: sid, cwd: home });
    expect(stop.output).toEqual({ decision: "block", reason: "Message from Raj via Tessera: stop after this file" });
    expect(results.map((r) => r.id)).toEqual(["m-1"]);
    expect(loadState(sid, null, null).inbox).toEqual([]);
  });

  it("an answer claimed by another hook's report still reaches the prompt waiting on it", async () => {
    const sid = "answer-elsewhere";
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "deploy" });
    // The answer is queued before the prompt's own first report, and a parallel agent's report takes it.
    const ask = handle(cfg, "PermissionRequest", { session_id: sid, cwd: home, tool_name: "Bash", tool_input: { command: "pnpm deploy" }, tool_use_id: "d1" });
    await new Promise((r) => setTimeout(r, 50));
    const askId = loadState(sid, null, null).openAsk?.id;
    expect(askId).toBeTruthy();
    queued = [{ id: "a-1", kind: "answer", askId: askId!, payload: { decision: "allow", by: "Ann" } }];
    await handle(cfg, "SubagentStart", { session_id: sid, cwd: home, agent_id: "ag-1", agent_type: "reviewer" });
    const r = await ask;
    expect(r.output).toMatchObject({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(results.map((x) => x.id)).toEqual(["a-1"]);
  });
});

describe("a message the mod delivers as a prompt", () => {
  it("does not name the session", async () => {
    const sid = "named-by-message";
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "Message from Raj via Tessera: push what you have" });
    expect(loadState(sid, null, null).name).toBeNull();
    await handle(cfg, "UserPromptSubmit", { session_id: sid, cwd: home, prompt: "fix the flaky refund test" });
    expect(loadState(sid, null, null).name).toBe("fix the flaky refund test");
  });
});

describe("the mod's live file", () => {
  const live = (sid: string, body: Record<string, unknown>) => {
    mkdirSync(join(home, "live"), { recursive: true });
    writeFileSync(join(home, "live", `${sid}.json`), JSON.stringify(body));
  };

  it("puts Claude Code's own context and cost in the report, and says the mod runs", () => {
    const sid = "live-fresh";
    live(sid, { v: 1, at: Date.now(), sessionId: sid, modVersion: "0.1.0", context: { tokens: 151_000, window: 1_000_000 }, costUsd: 1.25 });
    const r = buildReport(cfg, loadState(sid, home, null));
    expect(r.reporter.features).toEqual(["mod"]);
    expect(r.session.context).toEqual({ used: 151_000, window: 1_000_000 });
    expect(r.session.ledgerCostUsd).toBe(1.25);
  });

  it("is ignored once the mod stops refreshing it, or when it is half written", () => {
    const sid = "live-stale";
    live(sid, { v: 1, at: Date.now() - 5 * 60_000, sessionId: sid, modVersion: "0.1.0", context: { tokens: 10, window: 200_000 }, costUsd: 1 });
    expect(buildReport(cfg, loadState(sid, home, null)).reporter.features).toEqual([]);
    writeFileSync(join(home, "live", `${sid}.json`), '{"v":1,"at":');
    const r = buildReport(cfg, loadState(sid, home, null));
    expect(r.reporter.features).toEqual([]);
    expect(r.session.ledgerCostUsd).toBeNull();
  });

  it("is removed when the session ends", async () => {
    const sid = "live-end";
    live(sid, { v: 1, at: Date.now(), sessionId: sid, modVersion: "0.1.0", context: null, costUsd: null });
    await handle(cfg, "SessionEnd", { session_id: sid, cwd: home, reason: "exit" });
    expect(() => readFileSync(join(home, "live", `${sid}.json`))).toThrow();
  });
});

describe("installing the mod", () => {
  it("loads only on Claude Code 2.1.287 and later", () => {
    expect(claudeLoadsMods("2.1.304 (Claude Code)")).toBe(true);
    expect(claudeLoadsMods("2.1.287 (Claude Code)")).toBe(true);
    expect(claudeLoadsMods("2.1.286 (Claude Code)")).toBe(false);
    expect(claudeLoadsMods("1.9.999")).toBe(false);
    expect(claudeLoadsMods("3.0.0")).toBe(true);
    expect(claudeLoadsMods(null)).toBeNull();
  });

  it("writes the plugin and a marketplace for it, and switches it on and off in the settings", () => {
    expect(writeMod()).toBe("0.1.0");
    const register = readFileSync(join(MOD_DIR, "hooks", "register.js"), "utf8");
    expect(register).toContain("export function register(on)");
    expect(() => readFileSync(join(MOD_DIR, "tests", "tessera.test.ts")), "tests stay out of the install").toThrow();
    const market = JSON.parse(readFileSync(join(home, "claude-plugins", ".claude-plugin", "marketplace.json"), "utf8")) as { name: string; plugins: { source: string }[] };
    expect(market).toMatchObject({ name: "tessera", plugins: [{ name: "tessera", source: "./tessera" }] });
    const settings: Record<string, unknown> = { enabledPlugins: { "other@x": true } };
    enableMod(settings);
    expect(modInstalled(settings)).toBe(true);
    expect(settings.extraKnownMarketplaces).toEqual({ tessera: { source: { source: "directory", path: join(home, "claude-plugins") } } });
    disableMod(settings);
    expect(settings).toEqual({ enabledPlugins: { "other@x": true } });
    expect(PLUGIN_ID).toBe("tessera@tessera");
  });
});
