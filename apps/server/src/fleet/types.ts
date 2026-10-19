import type { Action, AgentReport, ChangedFile, GitInfo, OpenAsk, Plan, SessionStatus, TokenCounts, ModelUsage, WaitReason } from "@tessera/contract";

/** The server's own record of a session: what the reporter said plus what the server knows. */
export interface SessionRecord {
  orgId: string;
  id: string;
  teamId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  deviceId: string | null;
  name: string | null;
  reporterKind: string;
  reporterVersion: string;
  hostname: string | null;
  machineId: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  status: SessionStatus;
  waitReason: WaitReason | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  lastSeenAt: string;
  droppedAt: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  tokens: TokenCounts;
  usageByModel: ModelUsage[];
  ledgerCostUsd: number | null;
  blowouts: number;
  git: GitInfo | null;
  filesChanged: ChangedFile[];
  plan: Plan | null;
  openAsk: OpenAsk | null;
  tags: Record<string, string>;
  continuedFrom: string | null;
  control: SessionControl;
  agents: AgentReport[];
  /** The most recent tool calls, newest last (rows from before the column lack it). */
  activity?: Action[];
  /** The session's own tool calls per tool; agents carry their own. */
  toolCalls?: Record<string, number>;
}

/** What people in Tessera have done to a session, kept on the server (rows from before a field existed lack it). */
export interface SessionControl {
  paused: boolean;
  reason: string | null;
  by: string | null;
  /** Stop requested: the next tool call is refused and Claude is told to stop, once. */
  stop?: { by: string; reason: string | null; at: string } | null;
  /** Handed over: this person is told when the session waits and may act on it. */
  assignee?: { id: string; name: string; by: string; at: string } | null;
}
