import type { Action, AgentView } from "@tessera/contract";
import { describe, expect, it } from "vitest";
import { agentColors, agentLanes } from "./agents";

const agent = (id: string, over: Partial<AgentView> = {}) => ({ id, parentId: null, kind: "subagent", type: id, description: null, status: "running", startedAt: "2026-10-27T10:00:00.000Z", endedAt: null, ...over }) as AgentView;
let n = 0;
const call = (agentId: string | null, status: Action["status"] = "ok", ts = `2026-10-27T10:0${n++ % 10}:00.000Z`) => ({ id: `c${n}`, ts, tool: "Read", summary: `Read(${agentId})`, agentId, status, endedAt: null, durationMs: null, error: null }) as Action;

describe("agentLanes", () => {
  it("puts the session's own calls first, then running agents in the order they started, then finished ones", () => {
    const agents = [
      agent("done-early", { status: "done", endedAt: "2026-10-27T10:01:00.000Z" }),
      agent("late", { startedAt: "2026-10-27T10:05:00.000Z" }),
      agent("early", { startedAt: "2026-10-27T10:02:00.000Z" }),
      agent("done-late", { status: "failed", endedAt: "2026-10-27T10:09:00.000Z" }),
    ];
    expect(agentLanes(agents, []).map((l) => l.label)).toEqual(["Main session", "early", "late", "done-late", "done-early"]);
  });

  it("gives each agent only its own calls, oldest first, and what it is running now", () => {
    const lanes = agentLanes([agent("a"), agent("b")], [call("a", "ok", "2026-10-27T10:02:00.000Z"), call("b"), call(null), call("a", "running", "2026-10-27T10:03:00.000Z")]);
    const a = lanes.find((l) => l.key === "a")!;
    expect(a.calls.map((c) => c.status)).toEqual(["ok", "running"]);
    expect(a.running).toHaveLength(1);
    expect(a.last?.status).toBe("running");
    expect(lanes.find((l) => l.key === "main")!.calls).toHaveLength(1);
    expect(lanes.find((l) => l.key === "b")!.calls).toHaveLength(1);
  });

  it("keeps calls from an agent the session no longer lists, and drops an orchestrator with none", () => {
    const lanes = agentLanes([agent("o", { kind: "orchestrator" })], [call("gone")]);
    expect(lanes.map((l) => l.key)).toEqual(["main", "gone"]);
  });

  it("names the agent that started a nested one", () => {
    const lanes = agentLanes([agent("planner"), agent("worker", { parentId: "planner" })], []);
    expect(lanes.find((l) => l.key === "worker")!.parent).toBe("planner");
  });
});

describe("agentColors", () => {
  it("keeps an agent's colour when later agents start", () => {
    const first = agentColors([agent("a"), agent("b", { startedAt: "2026-10-27T10:01:00.000Z" })]);
    const later = agentColors([agent("c", { startedAt: "2026-10-27T10:02:00.000Z" }), agent("b", { startedAt: "2026-10-27T10:01:00.000Z" }), agent("a")]);
    expect(later.get("a")).toBe(first.get("a"));
    expect(later.get("b")).toBe(first.get("b"));
    expect(new Set(later.values()).size).toBe(3);
  });
});
