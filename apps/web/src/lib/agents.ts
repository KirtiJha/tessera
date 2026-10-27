import type { Action, AgentView } from "@tessera/contract";

/** How many agent hues styles.css defines (--color-agent-1 …). */
const HUES = 6;

/** The lane key of the session's own calls, made outside any agent; also what the actions endpoint takes for them. */
export const MAIN = "main";

export interface Lane {
  key: string;
  agent: AgentView | null;
  label: string;
  /** The agent's colour, or null for the session itself. */
  color: string | null;
  /** The agent that started this one, when that was another agent. */
  parent: string | null;
  /** Its calls, oldest first. */
  calls: Action[];
  running: Action[];
  last: Action | null;
}

export function agentLabel(a: AgentView): string {
  return a.kind === "orchestrator" ? "orchestrator" : (a.type ?? a.kind);
}

/** A colour per agent, by the order they started, so it stays put as the session goes on. */
export function agentColors(agents: AgentView[]): Map<string, string> {
  const order = [...agents].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return new Map(order.map((a, i) => [a.id, `var(--color-agent-${(i % HUES) + 1})`]));
}

/**
 * The session's calls split by who made them: the session itself first, then the
 * agents still running in the order they started, then the finished ones, latest
 * first. Calls from an agent the session no longer reports go to a lane of their own.
 */
export function agentLanes(agents: AgentView[], actions: Action[]): Lane[] {
  const colors = agentColors(agents);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const calls = new Map<string, Action[]>();
  for (const a of actions) {
    const key = a.agentId ?? MAIN;
    calls.set(key, [...(calls.get(key) ?? []), a]);
  }
  const lane = (key: string, agent: AgentView | null): Lane => {
    const mine = [...(calls.get(key) ?? [])].sort((x, y) => x.ts.localeCompare(y.ts));
    const parent = agent?.parentId ? byId.get(agent.parentId) : undefined;
    return {
      key,
      agent,
      label: agent ? agentLabel(agent) : key === MAIN ? "Main session" : "agent",
      color: agent ? colors.get(agent.id)! : null,
      parent: parent && parent.kind !== "orchestrator" ? agentLabel(parent) : null,
      calls: mine,
      running: mine.filter((a) => a.status === "running"),
      last: mine.at(-1) ?? null,
    };
  };
  // An orchestrator with no calls of its own is the session itself; it needs no lane.
  const shown = agents.filter((a) => a.kind !== "orchestrator" || calls.has(a.id));
  const running = shown.filter((a) => a.status === "running").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const finished = shown.filter((a) => a.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  const unknown = [...calls.keys()].filter((k) => k !== MAIN && !byId.has(k));
  return [lane(MAIN, null), ...running.map((a) => lane(a.id, a)), ...unknown.map((k) => lane(k, null)), ...finished.map((a) => lane(a.id, a))];
}
