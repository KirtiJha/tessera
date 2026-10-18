import type { SessionView } from "@tessera/contract";
import { describe, expect, it } from "vitest";
import { sessionKind, sessionLabel } from "./fleet";
import { fmtDuration, fmtTokens, fmtUsd, modelShort } from "./format";

const base: SessionView = {
  id: "abcdef12-0000",
  orgId: "o",
  teamId: null,
  name: null,
  ownerId: "u",
  ownerName: "Priya",
  machine: null,
  reporter: { kind: "claude-code-hooks", version: "0.1.0" },
  cwd: "/Users/priya/dev/payments-api",
  model: "claude-sonnet-4-5",
  effort: null,
  status: "running",
  stale: false,
  waitReason: null,
  startedAt: new Date().toISOString(),
  endedAt: null,
  endReason: null,
  lastSeenAt: new Date().toISOString(),
  context: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  unpricedModels: [],
  blowouts: 0,
  git: null,
  filesChanged: [],
  plan: null,
  agents: [],
  openAsk: null,
  tags: {},
  continuedFrom: null, assignee: null, stopRequested: false,
};

describe("sessionKind", () => {
  it("maps states to the five kinds", () => {
    expect(sessionKind(base)).toBe("running");
    expect(sessionKind({ ...base, status: "waiting", waitReason: "permission" })).toBe("waiting");
    expect(sessionKind({ ...base, status: "waiting", waitReason: "idle" })).toBe("running");
    expect(sessionKind({ ...base, status: "waiting", waitReason: "background" })).toBe("background");
    expect(sessionKind({ ...base, stale: true })).toBe("stale");
    expect(sessionKind({ ...base, status: "ended", stale: true })).toBe("done");
  });
  it("labels a session by name, then repo, then folder, then id", () => {
    expect(sessionLabel(base)).toBe("payments-api");
    expect(sessionLabel({ ...base, git: { repo: "acme/api", branch: null, worktree: null, ahead: 0, behind: 0, modified: 0 } })).toBe("acme/api");
    expect(sessionLabel({ ...base, name: "Fix refunds" })).toBe("Fix refunds");
    expect(sessionLabel({ ...base, cwd: null })).toBe("abcdef12");
  });
});

describe("format", () => {
  it("formats money, tokens, durations and models", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(12.5)).toBe("$12.50");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(15_300)).toBe("15k");
    expect(fmtTokens(2_340_000)).toBe("2.34M");
    expect(fmtDuration(65_000)).toBe("1m 5s");
    expect(modelShort("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelShort("gemma4:12b")).toBe("gemma4:12b");
  });
});
