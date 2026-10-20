import type { EventView, FleetSnapshot, Kpis, SessionView, StreamMessage } from "@tessera/contract";
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

export interface FleetState {
  connected: boolean;
  serverTime: string | null;
  config: FleetSnapshot["config"] | null;
  sessions: Map<string, SessionView>;
  kpis: Kpis | null;
  events: EventView[];
}

type Action =
  | { type: "connected"; value: boolean }
  | { type: "msg"; msg: StreamMessage };

const EMPTY: FleetState = { connected: false, serverTime: null, config: null, sessions: new Map(), kpis: null, events: [] };

function reducer(state: FleetState, action: Action): FleetState {
  if (action.type === "connected") return { ...state, connected: action.value };
  const m = action.msg;
  switch (m.type) {
    case "snapshot": {
      const sessions = new Map(m.data.sessions.map((s) => [s.id, s]));
      return { ...state, connected: true, serverTime: m.data.serverTime, config: m.data.config, sessions, kpis: m.data.kpis, events: m.data.recentEvents };
    }
    case "sessions": {
      if (!m.data.length) return state;
      const sessions = new Map(state.sessions);
      for (const s of m.data) sessions.set(s.id, s);
      return { ...state, sessions };
    }
    case "removed": {
      if (!state.sessions.has(m.data.id)) return state;
      const sessions = new Map(state.sessions);
      sessions.delete(m.data.id);
      return { ...state, sessions };
    }
    case "events": {
      const seen = new Set(state.events.map((e) => `${e.sessionId}:${e.id}`));
      const fresh = m.data.filter((e) => !seen.has(`${e.sessionId}:${e.id}`)).reverse();
      if (!fresh.length) return state;
      return { ...state, events: [...fresh, ...state.events].slice(0, 300) };
    }
    case "kpis":
      return { ...state, kpis: m.data };
    case "tick":
      return { ...state, serverTime: m.data.serverTime };
    default:
      return state;
  }
}

const Ctx = createContext<FleetState>(EMPTY);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let es: EventSource | null = null;
    let retry = 1000;
    let silence: ReturnType<typeof setTimeout> | null = null;

    const armSilence = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => {
        // No tick for a while: the connection is dead even if the browser thinks otherwise.
        es?.close();
        connect();
      }, 10_000);
    };

    const connect = () => {
      if (stopped.current) return;
      es = new EventSource("/api/fleet/stream");
      const on = (type: StreamMessage["type"]) =>
        es!.addEventListener(type, (ev) => {
          retry = 1000;
          armSilence();
          dispatch({ type: "msg", msg: { type, data: JSON.parse((ev as MessageEvent).data) } as StreamMessage });
        });
      (["snapshot", "sessions", "removed", "events", "kpis", "tick"] as const).forEach(on);
      es.onopen = () => dispatch({ type: "connected", value: true });
      es.onerror = () => {
        dispatch({ type: "connected", value: false });
        es?.close();
        if (silence) clearTimeout(silence);
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15_000);
      };
    };
    connect();
    return () => {
      stopped.current = true;
      if (silence) clearTimeout(silence);
      es?.close();
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useFleet(): FleetState {
  return useContext(Ctx);
}

export function useSessions(): SessionView[] {
  const { sessions } = useFleet();
  return useMemo(() => [...sessions.values()], [sessions]);
}

export type SessionKind = "waiting" | "running" | "background" | "stale" | "done";

export function sessionKind(s: SessionView): SessionKind {
  if (s.status === "ended") return "done";
  if (s.stale) return "stale";
  if (s.status === "waiting" && s.waitReason === "background") return "background";
  if (s.status === "waiting" && s.waitReason !== "idle") return "waiting";
  return "running";
}

/**
 * When a message sent now reaches the session. The Tessera mod delivers to a
 * session idle at the prompt at once; hooks alone deliver only when a turn
 * ends, so an idle session without the mod waits for its next turn.
 */
export function messageHint(s: Pick<SessionView, "reporter" | "status" | "waitReason">): string {
  const mod = (s.reporter.features ?? []).includes("mod");
  const idle = s.status === "waiting" && s.waitReason === "idle";
  if (idle && mod) return "Delivered at once: the session is idle and runs the Tessera mod, so it starts on your message.";
  if (idle) return "Delivered when the session's next turn ends. It is idle at the prompt, and without the Tessera mod (Claude Code 2.1.287 or later) nothing reaches it until it works again.";
  return "Delivered when the current turn ends, as an instruction to continue with.";
}

export function sessionLabel(s: SessionView): string {
  return s.name ?? s.git?.repo ?? (s.cwd ? s.cwd.split("/").filter(Boolean).pop() ?? s.id : s.id.slice(0, 8));
}
