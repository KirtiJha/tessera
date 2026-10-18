import type { AgentReport, ChangedFile, GitInfo, OpenAsk, Plan, SessionStatus, TokenCounts, ModelUsage, WaitReason } from "@tessera/contract";

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
  control: { paused: boolean; reason: string | null; by: string | null };
  agents: AgentReport[];
}
