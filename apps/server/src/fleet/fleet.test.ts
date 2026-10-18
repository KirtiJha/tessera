import { describe, expect, it } from "vitest";
import { deriveSession } from "./derive.js";
import { BUILTIN_PRICES } from "@tessera/contract";
import type { SessionRecord } from "./types.js";

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  orgId: "o",
  id: "s",
  teamId: null,
  ownerId: "u",
  ownerName: "Priya",
  deviceId: "d",
  name: null,
  reporterKind: "claude-code-hooks",
  reporterVersion: "0.1.0",
  hostname: "mbp",
  machineId: "m",
  cwd: null,
  model: "claude-sonnet-4-5",
  effort: null,
  status: "running",
  waitReason: null,
  startedAt: new Date().toISOString(),
  endedAt: null,
  endReason: null,
  lastSeenAt: new Date().toISOString(),
  droppedAt: null,
  contextUsed: 50_000,
  contextWindow: 200_000,
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  usageByModel: [{ model: "claude-sonnet-4-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ledgerCostUsd: null,
  blowouts: 0,
  git: null,
  filesChanged: [],
  plan: null,
  openAsk: null,
  tags: {},
  continuedFrom: null,
  control: { paused: false, reason: null, by: null },
  agents: [],
  ...over,
});

describe("deriveSession", () => {
  it("prices usage and reports context", () => {
    const v = deriveSession(rec(), BUILTIN_PRICES, Date.now(), 15_000);
    expect(v.costUsd).toBeCloseTo(3, 6);
    expect(v.context).toEqual({ used: 50_000, window: 200_000 });
    expect(v.stale).toBe(false);
  });
  it("marks a session stale after the threshold and never when ended", () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(deriveSession(rec({ lastSeenAt: old }), BUILTIN_PRICES, Date.now(), 15_000).stale).toBe(true);
    expect(deriveSession(rec({ lastSeenAt: old, status: "ended" }), BUILTIN_PRICES, Date.now(), 15_000).stale).toBe(false);
  });
  it("shows unknown cost for an unpriced model and surfaces a paused tag", () => {
    const v = deriveSession(rec({ usageByModel: [{ model: "gemma4:12b", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }], control: { paused: true, reason: "review", by: "Priya" } }), BUILTIN_PRICES, Date.now(), 15_000);
    expect(v.costUsd).toBeNull();
    expect(v.unpricedModels).toEqual(["gemma4:12b"]);
    expect(v.tags.paused).toBe("review");
  });
});

describe("session cost", async () => {
  const { totalUsage } = await import("@tessera/contract");
  it("counts every agent's usage with the session's own", () => {
    const u = totalUsage([{ model: "m", input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }], [{ usageByModel: [{ model: "m", input: 10, output: 0, cacheRead: 1, cacheWrite: 0 }, { model: "h", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }] }]);
    expect(u).toEqual([{ model: "m", input: 11, output: 2, cacheRead: 1, cacheWrite: 0 }, { model: "h", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }]);
  });
});
