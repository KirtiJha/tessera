import type { SessionView } from "@tessera/contract";
import { describe, expect, it } from "vitest";
import { healthFlags, healthLevel, medianCost, ticketOf } from "./health";

const now = Date.parse("2026-10-19T12:00:00.000Z");
const base = {
  id: "s",
  status: "running",
  waitReason: null,
  startedAt: "2026-10-19T11:00:00.000Z",
  lastSeenAt: "2026-10-19T11:59:50.000Z",
  stale: false,
  context: null,
  blowouts: 0,
  costUsd: 1,
  agents: [],
  openAsk: null,
  tags: {},
  git: { repo: "acme/payments", branch: "feat/PAY-142-refunds", worktree: null, ahead: 0, behind: 0, modified: 0 },
  filesChanged: [{ path: "a.ts", status: "modified", added: 1, removed: 0 }],
  activity: [],
} as unknown as SessionView;
const session = (over: Partial<SessionView>): SessionView => ({ ...base, ...over }) as SessionView;
const act = (status: string, tool = "Bash") => ({ id: Math.random().toString(36), ts: "2026-10-19T11:50:00.000Z", tool, summary: `${tool}(x)`, agentId: null, status, endedAt: null, durationMs: null, error: null }) as never;
const ctx = { now, medianCostUsd: 1 };

describe("healthFlags", () => {
  it("is quiet for an ordinary running session", () => {
    expect(healthFlags(session({}), ctx)).toEqual([]);
    expect(healthLevel([])).toBe("fine");
  });
  it("flags the same tool failing three times in the last five calls as stuck", () => {
    const f = healthFlags(session({ activity: [act("ok"), act("failed"), act("ok"), act("failed"), act("failed")] }), ctx);
    expect(f.map((x) => x.code)).toEqual(["stuck"]);
    expect(f[0]!.detail).toContain("(Bash)");
    expect(healthLevel(f)).toBe("attention");
  });
  it("flags repeated policy denials as watch", () => {
    expect(healthFlags(session({ activity: [act("denied"), act("denied"), act("denied"), act("ok"), act("ok")] }), ctx).map((x) => x.code)).toEqual(["denied"]);
  });
  it("grades the context window: filling at 80%, nearly full at 90%, plus repeated blowouts", () => {
    expect(healthFlags(session({ context: { used: 82, window: 100 } }), ctx)[0]).toMatchObject({ code: "context", level: "watch" });
    expect(healthFlags(session({ context: { used: 95, window: 100 } }), ctx)[0]).toMatchObject({ code: "context", level: "attention" });
    expect(healthFlags(session({ blowouts: 2 }), ctx).map((x) => x.code)).toEqual(["blowouts"]);
  });
  it("flags a prompt that has waited over ten minutes", () => {
    const s = session({ status: "waiting", waitReason: "permission", openAsk: { id: "a", kind: "permission", createdAt: "2026-10-19T11:45:00.000Z", tool: "Bash", prompt: "x", options: [], detail: null } as never });
    expect(healthFlags(s, ctx)[0]).toMatchObject({ code: "long-wait", level: "attention", label: "Waiting 15 min" });
    expect(healthFlags(session({ ...s, openAsk: { ...s.openAsk!, createdAt: "2026-10-19T11:55:00.000Z" } }), ctx)).toEqual([]);
  });
  it("flags a long session with many tool calls and no file changes, but not a short or productive one", () => {
    const busy = Array.from({ length: 25 }, () => act("ok", "Read"));
    expect(healthFlags(session({ activity: busy, filesChanged: [] }), ctx).map((x) => x.code)).toEqual(["no-progress"]);
    expect(healthFlags(session({ activity: busy }), ctx)).toEqual([]);
    expect(healthFlags(session({ activity: busy, filesChanged: [], startedAt: "2026-10-19T11:45:00.000Z" }), ctx)).toEqual([]);
  });
  it("flags a cost outlier only above $5 and three times the median", () => {
    expect(healthFlags(session({ costUsd: 4 }), { now, medianCostUsd: 1 })).toEqual([]);
    expect(healthFlags(session({ costUsd: 6 }), { now, medianCostUsd: 1 }).map((x) => x.code)).toEqual(["expensive"]);
    expect(healthFlags(session({ costUsd: 6 }), { now, medianCostUsd: 3 })).toEqual([]);
  });
  it("orders attention before watch and says nothing about an ended session", () => {
    const f = healthFlags(session({ blowouts: 3, context: { used: 95, window: 100 } }), ctx);
    expect(f.map((x) => x.level)).toEqual(["attention", "watch"]);
    expect(healthFlags(session({ status: "ended", blowouts: 3, context: { used: 95, window: 100 } }), ctx)).toEqual([]);
  });
});

describe("medianCost and ticketOf", () => {
  it("takes the median of priced sessions", () => {
    expect(medianCost([session({ costUsd: 1 }), session({ costUsd: 9 }), session({ costUsd: null }), session({ costUsd: 3 })])).toBe(3);
    expect(medianCost([session({ costUsd: 1 }), session({ costUsd: 3 })])).toBe(2);
    expect(medianCost([])).toBe(0);
  });
  it("reads the ticket from the tag first, then the branch", () => {
    expect(ticketOf(session({}))).toBe("PAY-142");
    expect(ticketOf(session({ tags: { ticket: "OPS-9" } }))).toBe("OPS-9");
    expect(ticketOf(session({ git: { ...base.git!, branch: "main" } }))).toBeNull();
  });
});
