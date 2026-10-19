import type {
  Action,
  AgentKind,
  AgentStatus,
  ChangedFile,
  ContextFill,
  Failure,
  GitInfo,
  ModelUsage,
  OpenAsk,
  Plan,
  SessionStatus,
  TokenCounts,
  WaitReason,
} from "./report.js";

/** What the console receives for one session. Derived on the server, never trusted from a reporter. */
export interface SessionView {
  id: string;
  orgId: string;
  teamId: string | null;
  name: string | null;
  ownerId: string | null;
  ownerName: string | null;
  machine: { hostname: string; machineId: string } | null;
  reporter: { kind: string; version: string };
  cwd: string | null;
  model: string | null;
  effort: string | null;
  status: SessionStatus;
  /** Server-side liveness: a session that has not reported for STALE_AFTER_MS. */
  stale: boolean;
  waitReason: WaitReason | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  lastSeenAt: string;
  context: ContextFill | null;
  tokens: TokenCounts;
  /** Tokens per model, so the console can show cache share and the model mix. */
  usageByModel: ModelUsage[];
  costUsd: number | null;
  unpricedModels: string[];
  blowouts: number;
  git: GitInfo | null;
  filesChanged: ChangedFile[];
  plan: Plan | null;
  agents: AgentView[];
  openAsk: OpenAsk | null;
  tags: Record<string, string>;
  continuedFrom: string | null;
  /** Handed over to this person, who is told when it waits and may act on it. */
  assignee: { id: string; name: string } | null;
  /** A stop was requested from Tessera and not yet applied. */
  stopRequested: boolean;
  /** The most recent tool calls, newest last. */
  activity: Action[];
}

export interface AgentView {
  id: string;
  parentId: string | null;
  kind: AgentKind;
  type: string | null;
  description: string | null;
  model: string | null;
  effort: string | null;
  status: AgentStatus;
  startedAt: string;
  endedAt: string | null;
  tokens: TokenCounts;
  /** Tokens per model, so the console can show cache share and the model mix. */
  usageByModel: ModelUsage[];
  costUsd: number | null;
  context: ContextFill | null;
  toolCalls: Record<string, number>;
  skills: string[];
  failure: Failure | null;
  promptExcerpt: string | null;
  answerExcerpt: string | null;
}

export interface EventView {
  id: string;
  sessionId: string;
  ts: string;
  kind: string;
  agentId: string | null;
  text: string;
}

export interface Kpis {
  liveSessions: number;
  waitingSessions: number;
  runningAgents: number;
  failedAgentsToday: number;
  costTodayUsd: number;
  tokensPerMinute: number[];
  costPerMinuteUsd: number[];
  blowoutsToday: number;
  unpricedSessions: number;
}

export interface FleetSnapshot {
  serverTime: string;
  config: { staleAfterMs: number; dropAfterMs: number; lingerMs: number };
  sessions: SessionView[];
  kpis: Kpis;
  recentEvents: EventView[];
}

/**
 * Messages on the console stream. Session changes and new events are batched
 * per organisation and flushed together (every 500 ms by default), so a busy
 * fleet sends a few messages a second instead of one per report.
 */
export type StreamMessage =
  | { type: "snapshot"; data: FleetSnapshot }
  | { type: "sessions"; data: SessionView[] }
  | { type: "events"; data: EventView[] }
  | { type: "removed"; data: { id: string } }
  | { type: "kpis"; data: Kpis }
  | { type: "tick"; data: { serverTime: string } };
