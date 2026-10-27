import type { AgentView } from "@tessera/contract";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { agentColors, agentNames, MAIN } from "./agents";

/** One edit or write, as the server counts them: who touched which file. */
export interface Touched { path: string; agentId: string | null; edits: number; lastAt: string }

/** Who made a piece of work: an agent, or the session itself. */
export interface Actor { key: string; label: string; color: string | null }

interface FocusValue {
  /** An agent's id, MAIN for the session's own work, or null for everyone. */
  focus: string | null;
  setFocus: (key: string | null) => void;
  /** Whether a call, event or edit with this agent id is in focus. */
  inFocus: (agentId: string | null) => boolean;
  actor: (agentId: string | null) => Actor;
  /** Who edited a changed file, by its path relative to the repository or absolute. */
  whoTouched: (path: string) => Actor[];
  /** The session has agents, so work can be told apart at all. */
  split: boolean;
}

const MAIN_ACTOR: Actor = { key: MAIN, label: "main", color: null };

export const keyOf = (agentId: string | null) => agentId ?? MAIN;

/**
 * Whether `abs`, a path a tool call reported, is the changed file `rel`, which
 * git reports relative to the repository; absolute paths compare as they are.
 */
export function samePath(abs: string, rel: string): boolean {
  return abs === rel || abs.endsWith(`/${rel.replace(/^\.\//, "")}`);
}

/** The agent ids that edited a file; null is the session itself. */
export function touchedBy(touched: Touched[], path: string): (string | null)[] {
  const ids = new Set<string | null>();
  for (const t of touched) if (samePath(t.path, path)) ids.add(t.agentId);
  return [...ids];
}

const FocusContext = createContext<FocusValue>({
  focus: null,
  setFocus: () => {},
  inFocus: () => true,
  actor: () => MAIN_ACTOR,
  whoTouched: () => [],
  split: false,
});

/** The session page's agent focus: which agent's work its sections show. Off the page, everything is in focus. */
export function AgentFocusProvider({ agents, touched, focus, setFocus, children }: { agents: AgentView[]; touched: Touched[]; focus: string | null; setFocus: (key: string | null) => void; children: ReactNode }) {
  const value = useMemo<FocusValue>(() => {
    const colors = agentColors(agents);
    const names = agentNames(agents);
    const actor = (agentId: string | null): Actor => (agentId ? { key: agentId, label: names.get(agentId) ?? "agent", color: colors.get(agentId) ?? null } : MAIN_ACTOR);
    return {
      focus,
      setFocus,
      inFocus: (agentId) => focus === null || keyOf(agentId) === focus,
      actor,
      whoTouched: (path) => touchedBy(touched, path).map(actor),
      split: agents.some((a) => a.kind !== "orchestrator"),
    };
  }, [agents, touched, focus, setFocus]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export const useAgentFocus = () => useContext(FocusContext);

/** An agent's name in its colour, or "main" for the session's own work. */
export function ActorTag({ actor, className = "" }: { actor: Actor; className?: string }) {
  return (
    <span className={`inline-flex max-w-[10rem] items-center gap-1 truncate text-[11px] font-medium ${className}`} style={{ color: actor.color ?? "var(--color-fog)" }}>
      <i className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: actor.color ?? "var(--color-line-2)" }} />
      <span className="truncate">{actor.label}</span>
    </span>
  );
}
