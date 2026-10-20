import { z } from "zod";

/**
 * Tessera telemetry contract, schema 1.0.
 *
 * A report is a full snapshot of one session plus the events the server has
 * not acknowledged yet. The server upserts the snapshot and inserts events
 * idempotently, so a lost, duplicated or re-ordered report can never corrupt
 * state. Every string is bounded here; the server also strips control
 * characters before storing anything.
 */

export const SCHEMA_VERSION = "1.0";

const short = (max: number) => z.string().max(max);
const id = short(128).min(1);

export const SessionStatus = z.enum(["running", "waiting", "idle", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AgentStatus = z.enum(["running", "done", "failed", "aborted"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentKind = z.enum(["subagent", "fork", "teammate", "orchestrator"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const Effort = z.enum(["low", "medium", "high", "max"]).nullable();

export const TokenCounts = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCounts>;

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const ModelUsage = TokenCounts.extend({
  model: short(120),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ContextFill = z.object({
  used: z.number().int().nonnegative(),
  window: z.number().int().positive(),
});
export type ContextFill = z.infer<typeof ContextFill>;

export const GitInfo = z.object({
  repo: short(200).nullable().default(null),
  branch: short(200).nullable().default(null),
  worktree: short(400).nullable().default(null),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  modified: z.number().int().nonnegative().default(0),
});
export type GitInfo = z.infer<typeof GitInfo>;

export const ChangedFile = z.object({
  path: short(400),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  added: z.number().int().nonnegative().default(0),
  removed: z.number().int().nonnegative().default(0),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const PlanStep = z.object({
  id: id,
  title: short(300),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  ownerAgentId: id.nullable().default(null),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  title: short(300).nullable().default(null),
  source: short(60).nullable().default(null),
  steps: z.array(PlanStep).max(200),
});
export type Plan = z.infer<typeof Plan>;

export const FailureClass = z.enum([
  "permission_denied",
  "refusal",
  "context_exhausted",
  "api_error",
  "aborted",
  "tool_error",
  "unknown",
]);
export type FailureClass = z.infer<typeof FailureClass>;

export const Failure = z.object({
  class: FailureClass,
  at: z.string().datetime(),
  tool: short(120).nullable().default(null),
  summary: short(500),
  exitCode: z.number().int().nullable().default(null),
  outputTail: z.array(short(240)).max(12).default([]),
});
export type Failure = z.infer<typeof Failure>;

export const AgentReport = z.object({
  id: id,
  parentId: id.nullable().default(null),
  kind: AgentKind,
  type: short(120).nullable().default(null),
  description: short(400).nullable().default(null),
  model: short(120).nullable().default(null),
  effort: Effort.default(null),
  status: AgentStatus,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  tokens: TokenCounts.default(ZERO_TOKENS),
  usageByModel: z.array(ModelUsage).max(50).default([]),
  context: ContextFill.nullable().default(null),
  toolCalls: z.record(short(120), z.number().int().nonnegative()).default({}),
  skills: z.array(short(120)).max(50).default([]),
  failure: Failure.nullable().default(null),
  promptExcerpt: short(400).nullable().default(null),
  answerExcerpt: short(400).nullable().default(null),
});
export type AgentReport = z.infer<typeof AgentReport>;

export const WaitReason = z.enum(["question", "plan", "permission", "idle", "background"]);
export type WaitReason = z.infer<typeof WaitReason>;

/** One edit the agent wants to make, as it would appear in a diff. */
export const EditPreview = z.object({
  path: short(400),
  before: short(6000),
  after: short(6000),
  replaceAll: z.boolean().default(false),
});
export type EditPreview = z.infer<typeof EditPreview>;

export const QuestionOption = z.object({ label: short(300), description: short(500).nullable().default(null) });
export const Question = z.object({
  question: short(1000),
  header: short(60).nullable().default(null),
  options: z.array(QuestionOption).max(20).default([]),
  multiSelect: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

/** A permission rule the runtime could remember, so this call is not asked about again: "Bash(pnpm test:*)". */
export const SuggestedRule = z.object({ tool: short(120), content: short(300).nullable().default(null) });
export type SuggestedRule = z.infer<typeof SuggestedRule>;

/**
 * Everything the reporter can show about what is being asked, so the person
 * deciding sees the actual command, the actual change, and what led up to it.
 * Redacted on the machine before it is sent; the server scrubs it again.
 */
export const AskDetail = z.object({
  /** The whole command, for Bash. */
  command: short(4000).nullable().default(null),
  /** The runtime's one-line description of the call, when it gives one. */
  description: short(500).nullable().default(null),
  /** File edits with before and after text. */
  edits: z.array(EditPreview).max(20).default([]),
  /** A file about to be written whole: the first part of its content. */
  write: z.object({ path: short(400), excerpt: short(6000), lines: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).nullable().default(null),
  url: short(1000).nullable().default(null),
  paths: z.array(short(400)).max(20).default([]),
  /** The agent's own last words before asking: its account of why. */
  rationale: short(1500).nullable().default(null),
  /** The Tessera policy rule that turned this call into a prompt, if one did. */
  forcedBy: short(400).nullable().default(null),
  /** Rules the runtime suggests for allowing this next time, in order. */
  suggestedRules: z.array(SuggestedRule).max(5).default([]),
  /** Multiple-choice questions, for kind "question". */
  questions: z.array(Question).max(4).default([]),
});
export type AskDetail = z.infer<typeof AskDetail>;

export const OpenAsk = z.object({
  id: id,
  kind: z.enum(["question", "plan", "permission"]),
  createdAt: z.string().datetime(),
  tool: short(120).nullable().default(null),
  prompt: short(4000),
  options: z.array(short(300)).max(20).default([]),
  detail: AskDetail.nullable().default(null),
  /** Until when an answer from Tessera can still be applied; after that the terminal shows its own dialog. */
  answerableUntil: z.string().datetime().nullable().default(null),
  /** Not answered from Tessera in time: the prompt is now waiting in the terminal, and only there. */
  inTerminal: z.boolean().default(false),
});
export type OpenAsk = z.infer<typeof OpenAsk>;

/** One tool call, as it runs: what the live wall shows as "now doing" and what an approver sees as "what led here". */
export const Action = z.object({
  id: id,
  ts: z.string().datetime(),
  tool: short(120),
  summary: short(300),
  agentId: id.nullable().default(null),
  status: z.enum(["running", "ok", "failed", "denied"]),
  endedAt: z.string().datetime().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  error: short(300).nullable().default(null),
});
export type Action = z.infer<typeof Action>;

export const SessionReport = z.object({
  id: id,
  name: short(200).nullable().default(null),
  cwd: short(400).nullable().default(null),
  model: short(120).nullable().default(null),
  effort: Effort.default(null),
  status: SessionStatus,
  waitReason: WaitReason.nullable().default(null),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  endReason: short(60).nullable().default(null),
  context: ContextFill.nullable().default(null),
  tokens: TokenCounts.default(ZERO_TOKENS),
  usageByModel: z.array(ModelUsage).max(50).default([]),
  /** The runtime's own cost ledger when it has one. Tessera prices tokens itself; this is a cross-check. */
  ledgerCostUsd: z.number().nonnegative().nullable().default(null),
  blowouts: z.number().int().nonnegative().default(0),
  git: GitInfo.nullable().default(null),
  filesChanged: z.array(ChangedFile).max(200).default([]),
  plan: Plan.nullable().default(null),
  agents: z.array(AgentReport).max(2000).default([]),
  openAsk: OpenAsk.nullable().default(null),
  tags: z.record(short(60), short(200)).default({}),
  continuedFrom: id.nullable().default(null),
  /** The most recent tool calls, newest last. */
  activity: z.array(Action).max(40).default([]),
  /** The session's own tool calls per tool, over its whole life; agents carry their own. */
  toolCalls: z.record(short(120), z.number().int().nonnegative()).default({}),
});
export type SessionReport = z.infer<typeof SessionReport>;

export const EventKind = z.enum([
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "agent.spawn",
  "agent.done",
  "agent.fail",
  "tool.fail",
  "context.blowout",
  "context.compact",
  "wait",
  "answer",
  "note",
]);
export type EventKind = z.infer<typeof EventKind>;

export const ActivityEvent = z.object({
  id: id,
  ts: z.string().datetime(),
  kind: EventKind,
  agentId: id.nullable().default(null),
  text: short(500),
  data: z.record(z.unknown()).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ReporterInfo = z.object({
  kind: z.enum(["claude-code-hooks", "claude-code-plugin", "codex-cli", "gemini-cli", "cursor", "custom"]),
  version: short(40),
  schema: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  /**
   * What this reporter can do beyond the hooks. "mod": the Tessera mod runs
   * inside Claude Code, so a message reaches an idle session at once and the
   * context numbers are Claude Code's own.
   */
  features: z.array(short(40)).max(20).default([]),
});
export type ReporterInfo = z.infer<typeof ReporterInfo>;

export const MachineInfo = z.object({
  hostname: short(120),
  machineId: short(64),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

export const Report = z.object({
  v: z.literal(1),
  sentAt: z.string().datetime(),
  reporter: ReporterInfo,
  machine: MachineInfo,
  session: SessionReport,
  events: z.array(ActivityEvent).max(500).default([]),
  /**
   * False for a keep-alive sent while the session waits at the terminal: it
   * refreshes the snapshot but leaves queued answers and messages for the hook
   * that can act on them.
   */
  claimDeliveries: z.boolean().default(true),
});
export type Report = z.infer<typeof Report>;

export const Presence = z.enum(["auto", "desk", "away"]);
export type Presence = z.infer<typeof Presence>;

export const ReportAck = z.object({
  ok: z.literal(true),
  serverTime: z.string().datetime(),
  sessionId: z.string(),
  ackedEvents: z.array(z.string()),
  liveSessions: z.number().int().nonnegative(),
  /** Deliveries waiting for this session: answers to asks, messages, commands. */
  deliveries: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["answer", "message", "command"]),
      askId: z.string().nullable(),
      payload: z.record(z.unknown()),
    }),
  ),
  reporterSupport: z.enum(["ok", "outdated", "newer", "unknown"]),
  /**
   * The session owner's choice of how long prompts wait for Tessera before the
   * terminal asks: "desk" (briefly, the terminal first), "away" (up to ten
   * minutes), or "auto" (the machine's own setting).
   */
  presence: Presence.default("auto"),
});
export type ReportAck = z.infer<typeof ReportAck>;

/** Validate a raw body. Returns a typed report or a readable error. */
export function parseReport(body: unknown): { ok: true; report: Report } | { ok: false; error: string } {
  const r = Report.safeParse(body);
  if (r.success) return { ok: true, report: r.data };
  const first = r.error.issues[0];
  const path = first?.path.join(".") || "(root)";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
