import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// config.ts reads TESSERA_HOME when it loads, so point it at a scratch home before importing anything.
const home = mkdtempSync(join(tmpdir(), "tessera-filter-"));
process.env.TESSERA_HOME = home;
const { findBlocked, maskBlocked } = await import("./transport.js");
import type { Report } from "@tessera/contract";

const cfg = { serverUrl: "http://tessera.test", token: "tsr_test", label: "t", machineId: "m", excerpts: true, permissionWaitSeconds: 2, questionWaitSeconds: 1 };
let sent = 0;
let claimed = 0;

/** A web filter that blocks any POST whose body has a command substitution next to a curl, as some do. */
function filteringFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  sent++;
  const body = String(init?.body ?? "");
  if (JSON.parse(body).claimDeliveries) claimed++;
  if (/curl[^,]{0,120}\$\(/.test(body)) return Promise.resolve(new Response("<html><body>Access denied by policy</body></html>", { status: 403, headers: { "content-type": "text/html" } }));
  return Promise.resolve(new Response(JSON.stringify({ ok: true, serverTime: new Date().toISOString(), sessionId: "s", ackedEvents: [], liveSessions: 1, deliveries: [], reporterSupport: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
}

const at = new Date().toISOString();
const call = (id: string, summary: string) => ({ id, ts: at, tool: "Bash", summary, agentId: null, status: "ok" as const, endedAt: at, durationMs: 5, error: null });
const report = {
  v: 1, claimDeliveries: true, sentAt: at, reporter: { kind: "claude-code-hooks", version: "0.1.0" }, machine: { hostname: "h", machineId: "m" },
  session: {
    id: "s", name: "sync", cwd: "/w", status: "running", startedAt: at, agents: [], tags: {}, openAsk: null,
    activity: [call("a1", "Bash(pnpm test)"), call("a2", 'Bash(curl -s "https://api.github.com/x?sha=$(git rev-parse HEAD)")'), call("a3", "Bash(git status)"), call("a4", "Bash(ls)")],
  },
  events: [{ id: "e1", ts: at, kind: "note", agentId: null, text: "fine" }, { id: "e2", ts: at, kind: "tool.fail", agentId: null, text: 'Bash(curl "$(cat url)") failed' }],
} as unknown as Report;

beforeAll(() => vi.stubGlobal("fetch", filteringFetch));
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("a web filter that blocks a few lines of a report", () => {
  it("is narrowed to those lines, with probes that claim no deliveries", async () => {
    expect(await findBlocked(cfg, report, 1000)).toEqual(["a:a2", "e:e2"]);
    expect(claimed).toBe(0);
    expect(sent).toBeLessThanOrEqual(12);
  });

  it("withholds only those lines, and the rest goes through in full", async () => {
    const masked = maskBlocked(report, new Set(["a:a2", "e:e2"]));
    expect(masked.session.activity.map((a) => a.summary)).toEqual(["Bash(pnpm test)", "Bash(…)", "Bash(git status)", "Bash(ls)"]);
    expect(masked.session.activity[1]!.withheld).toBe(true);
    expect(masked.session.tags["network-filter"]).toBe("2 withheld");
    expect(masked.events[0]!.text).toBe("fine");
    await expect(filteringFetch("http://tessera.test/api/ingest/report", { body: JSON.stringify(masked) }).then((r) => r.status)).resolves.toBe(200);
  });

  it("gives up, leaving everything withheld, when its probes run out", async () => {
    expect(await findBlocked(cfg, report, 1000, 2)).toBeNull();
  });
});
