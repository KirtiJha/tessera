import type { SessionView } from "@tessera/contract";
import { describe, expect, it } from "vitest";
import { attentionItems, budgetOutlook, type BudgetStatus } from "./attention";

const base = {
  ownerId: "u1",
  ownerName: "Erin",
  machine: null,
  reporter: { kind: "claude-code-hooks", version: "0.1.0", features: [] },
  cwd: "/work/payments",
  model: "claude-sonnet-4-5",
  effort: null,
  status: "running",
  waitReason: null,
  startedAt: "2026-10-19T09:00:00.000Z",
  endedAt: null,
  endReason: null,
  lastSeenAt: "2026-10-19T09:05:00.000Z",
  stale: false,
  context: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  usageByModel: [],
  costUsd: 0,
  unpricedModels: [],
  blowouts: 0,
  git: { repo: "acme/payments", branch: "main", worktree: null, ahead: 0, behind: 0, modified: 0 },
  filesChanged: [],
  workedIn: [],
  plan: null,
  agents: [],
  openAsk: null,
  tags: {},
  continuedFrom: null,
  stopRequested: false,
  assignee: null,
  activity: [],
} as unknown as SessionView;

const session = (over: Partial<SessionView>): SessionView => ({ ...base, ...over }) as SessionView;
const agent = (id: string, status: string, endedAt: string | null, summary?: string) =>
  ({ id, parentId: null, kind: "subagent", type: "tester", description: null, model: null, effort: null, status, startedAt: "2026-10-19T09:01:00.000Z", endedAt, tokens: base.tokens, costUsd: 0, context: null, toolCalls: {}, skills: [], failure: summary ? { class: "tool_error", at: endedAt, tool: "Bash", summary, exitCode: 1, outputTail: [] } : null, promptExcerpt: null, answerExcerpt: null }) as never;

describe("attentionItems", () => {
  it("lists a waiting session with what it is asking", () => {
    const s = session({ id: "s1", status: "waiting", waitReason: "permission", openAsk: { id: "a1", kind: "permission", createdAt: "2026-10-19T09:04:00.000Z", tool: "Bash", prompt: "rm -rf dist", options: [], detail: null } as never });
    const [item] = attentionItems([s], []);
    expect(item).toMatchObject({ kind: "waiting", href: "/app/sessions/s1", since: "2026-10-19T09:04:00.000Z" });
    expect(item!.title).toBe("acme/payments · Permission needed");
    expect(item!.detail).toBe("Erin · Bash · rm -rf dist");
  });

  it("does not count idle or background waits, nor ended sessions", () => {
    expect(attentionItems([session({ status: "waiting", waitReason: "idle" }), session({ status: "waiting", waitReason: "background" }), session({ status: "ended", endedAt: "2026-10-19T10:00:00.000Z", agents: [agent("x", "failed", "2026-10-19T09:30:00.000Z", "boom")] })], [])).toEqual([]);
  });

  it("reports failed agents once per session with the latest failure", () => {
    const s = session({ id: "s2", agents: [agent("a", "failed", "2026-10-19T09:10:00.000Z", "first"), agent("b", "failed", "2026-10-19T09:20:00.000Z", "second"), agent("c", "done", "2026-10-19T09:21:00.000Z")] });
    const items = attentionItems([s], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "failed", title: "acme/payments · 2 agents failed", detail: "Erin · second", since: "2026-10-19T09:20:00.000Z" });
  });

  it("includes budgets at or over a limit, and says when enforcement is denying calls", () => {
    const budgets: BudgetStatus[] = [
      { id: "b1", scopeType: "org", scopeId: null, window: "daily", softUsd: 50, hardUsd: 100, enforce: true, spentUsd: 120, level: "hard", windowStart: "2026-10-19T00:00:00.000Z" },
      { id: "b2", scopeType: "team", scopeId: "t1", scopeName: "Payments", window: "weekly", softUsd: 500, hardUsd: null, enforce: false, spentUsd: 510.5, level: "soft", windowStart: "2026-10-19T00:00:00.000Z" },
      { id: "b3", scopeType: "user", scopeId: "u9", window: "monthly", softUsd: 10, hardUsd: 20, enforce: false, spentUsd: 1, level: "ok", windowStart: "2026-10-01T00:00:00.000Z" },
    ];
    const items = attentionItems([], budgets);
    expect(items.map((i) => i.title)).toEqual(["Organisation · hard daily budget reached", "Payments · soft weekly budget reached"]);
    expect(items[0]!.detail).toBe("$120.00 of $100.00 · new tool calls are being denied");
    expect(items[1]!.detail).toBe("$510.50 of $500.00");
    expect(items.every((i) => i.href === "/app/budgets")).toBe(true);
  });

  it("orders waiting first, then failures, then budgets, oldest first within a kind", () => {
    const later = session({ id: "w2", status: "waiting", waitReason: "question", openAsk: { id: "q", kind: "question", createdAt: "2026-10-19T09:06:00.000Z", tool: null, prompt: "Which?", options: [], detail: null } as never });
    const earlier = session({ id: "w1", status: "waiting", waitReason: "plan", openAsk: { id: "p", kind: "plan", createdAt: "2026-10-19T09:02:00.000Z", tool: null, prompt: "Plan", options: [], detail: null } as never });
    const failed = session({ id: "f1", agents: [agent("a", "failed", "2026-10-19T09:00:30.000Z", "x")] });
    const ids = attentionItems([failed, later, earlier], [{ id: "b", scopeType: "org", scopeId: null, window: "daily", softUsd: 1, hardUsd: null, enforce: false, spentUsd: 2, level: "soft", windowStart: "2026-10-19T00:00:00.000Z" }]).map((i) => i.id);
    expect(ids).toEqual(["waiting:w1", "waiting:w2", "failed:f1", "budget:b"]);
  });
});

describe("budgetOutlook", () => {
  const daily = (spentUsd: number, over: Partial<BudgetStatus> = {}): BudgetStatus => ({ id: "d", scopeType: "org", scopeId: null, window: "daily", softUsd: 80, hardUsd: 100, enforce: false, spentUsd, level: "ok", windowStart: "2026-10-19T00:00:00.000Z", ...over });
  it("projects the day's spend from the pace so far, against the hard limit when there is one", () => {
    const noon = Date.parse("2026-10-19T12:00:00.000Z");
    const o = budgetOutlook(daily(30), noon);
    expect(o.projectedUsd).toBeCloseTo(60);
    expect(o.limit).toBe(100);
    expect(o.pct).toBeCloseTo(30);
    expect(o.endsAt).toBe(Date.parse("2026-10-20T00:00:00.000Z"));
  });
  it("falls back to the soft limit, and does not explode in the first minute of a window", () => {
    const o = budgetOutlook(daily(5, { hardUsd: null }), Date.parse("2026-10-19T00:00:10.000Z"));
    expect(o.limit).toBe(80);
    expect(o.projectedUsd).toBeCloseTo(5 * 1440); // a minute's pace over a day, not ten seconds'
  });
  it("ends a monthly window a calendar month later", () => {
    const o = budgetOutlook({ ...daily(10), window: "monthly", windowStart: "2026-10-01T00:00:00.000Z" }, Date.parse("2026-10-16T00:00:00.000Z"));
    expect(new Date(o.endsAt).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(o.projectedUsd).toBeCloseTo(10 * (31 / 15));
  });
});
