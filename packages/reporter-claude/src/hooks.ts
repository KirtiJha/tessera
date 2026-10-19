import { clean, type AskDetail, type DecideRequest, type DecideResponse, type Question, type ReportAck, type SuggestedRule } from "@tessera/contract";
import { log, type Config } from "./config.js";
import { addEvent, deleteState, endAction, startAction, updateState, type AgentState, type SessionState } from "./state.js";
import { advance, newCursor } from "./transcript.js";
import { budget, buildReport, get, gitInfo, post, request, sendReport } from "./transport.js";

/** What Claude Code pipes to a hook on stdin. Fields differ by event; all are optional here. */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  notification_type?: string;
  message?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  trigger?: string;
  reason?: string;
  permission_suggestions?: unknown[];
  duration_ms?: number;
}

/** A permission update entry, as Claude Code suggests them and accepts them back. */
interface PermissionUpdate {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  destination?: string;
}

type Delivery = ReportAck["deliveries"][number];

/** Change state under the session's lock. Synchronous on purpose: the network never runs under the lock. */
type Txn = <T>(fn: (s: SessionState) => T) => T;

function toolSummary(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!tool) return "tool";
  const i = input ?? {};
  if (tool === "Bash" && typeof i.command === "string") return `${tool}(${clean(i.command, 160)})`;
  const path = (i.file_path ?? i.path ?? i.notebook_path) as string | undefined;
  if (path) return `${tool}(${clean(path, 160)})`;
  if (tool === "Agent" || tool === "Task") return `${tool}(${clean(String(i.description ?? i.subagent_type ?? ""), 120)})`;
  if (typeof i.pattern === "string") return `${tool}(${clean(i.pattern, 120)})`;
  if (typeof i.url === "string") return `${tool}(${clean(i.url, 120)})`;
  return tool;
}

/**
 * What the policy check needs to know about a tool call: the command, the
 * paths and the URL it touches. Redacted here, before it leaves the machine.
 */
export function decideRequest(sessionId: string, tool: string, input: Record<string, unknown> | undefined): DecideRequest {
  const i = input ?? {};
  const req: DecideRequest = { sessionId, tool };
  if (typeof i.command === "string") req.command = clean(i.command, 2000);
  const paths = [i.file_path, i.path, i.notebook_path].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (Array.isArray(i.edits)) for (const e of i.edits) if (e && typeof (e as { file_path?: unknown }).file_path === "string") paths.push((e as { file_path: string }).file_path);
  if (paths.length) req.paths = [...new Set(paths)].slice(0, 20).map((p) => clean(p, 400));
  if (typeof i.url === "string") req.url = clean(i.url, 1000);
  return req;
}

/**
 * Everything worth showing to the person who decides, taken from the tool's
 * input and redacted here. Edits carry their before and after text, a whole
 * file write carries its first part, a command carries all of itself.
 */
export function askDetail(tool: string, input: Record<string, unknown> | undefined, suggestions: unknown[] | undefined, rationale: string | null, forcedBy: string | null): AskDetail {
  const i = input ?? {};
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length ? clean(v, max) : null);
  const edits: AskDetail["edits"] = [];
  const path = str(i.file_path ?? i.path ?? i.notebook_path, 400);
  if ((tool === "Edit" || tool === "NotebookEdit") && path && (typeof i.old_string === "string" || typeof i.new_string === "string" || typeof i.new_source === "string")) {
    edits.push({ path, before: str(i.old_string, 6000) ?? "", after: str(i.new_string ?? i.new_source, 6000) ?? "", replaceAll: i.replace_all === true });
  }
  if (Array.isArray(i.edits)) {
    for (const e of i.edits.slice(0, 20)) {
      const x = e as { file_path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown };
      const ep = str(x.file_path, 400) ?? path;
      if (ep) edits.push({ path: ep, before: str(x.old_string, 6000) ?? "", after: str(x.new_string, 6000) ?? "", replaceAll: x.replace_all === true });
    }
  }
  let write: AskDetail["write"] = null;
  if (tool === "Write" && path && typeof i.content === "string") {
    const content = i.content;
    write = { path, excerpt: clean(content, 6000), lines: content.split("\n").length, bytes: Buffer.byteLength(content, "utf8") };
  }
  const paths = [...new Set([path, ...edits.map((e) => e.path)].filter((p): p is string => !!p))].slice(0, 20);
  const suggestedRules: SuggestedRule[] = [];
  for (const u of (suggestions ?? []) as PermissionUpdate[]) {
    if (u && u.type === "addRules" && u.behavior === "allow" && Array.isArray(u.rules)) {
      for (const r of u.rules) if (r && typeof r.toolName === "string") suggestedRules.push({ tool: clean(r.toolName, 120), content: typeof r.ruleContent === "string" ? clean(r.ruleContent, 300) : null });
    }
  }
  const questions: Question[] = [];
  if (tool === "AskUserQuestion" && Array.isArray(i.questions)) {
    for (const q of i.questions.slice(0, 4)) {
      const x = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
      if (typeof x.question !== "string") continue;
      const options = Array.isArray(x.options) ? x.options.slice(0, 20).map((o) => { const y = o as { label?: unknown; description?: unknown }; return { label: str(y.label, 300) ?? "", description: str(y.description, 500) }; }).filter((o) => o.label) : [];
      questions.push({ question: clean(x.question, 1000), header: str(x.header, 60), options, multiSelect: x.multiSelect === true });
    }
  }
  return {
    command: tool === "Bash" || tool === "PowerShell" ? str(i.command, 4000) : null,
    description: str(i.description, 500),
    edits,
    write,
    url: str(i.url, 1000),
    paths,
    rationale,
    forcedBy,
    suggestedRules: suggestedRules.slice(0, 5),
    questions,
  };
}

/** Turn an approver's "allow for this session" into the permission update Claude Code applies. */
export function sessionRule(rule: unknown): PermissionUpdate | null {
  const r = rule as { tool?: unknown; content?: unknown } | null;
  if (!r || typeof r.tool !== "string" || !r.tool.trim()) return null;
  const content = typeof r.content === "string" && r.content.trim() ? r.content.trim().slice(0, 300) : undefined;
  return { type: "addRules", rules: [{ toolName: r.tool.trim().slice(0, 120), ...(content ? { ruleContent: content } : {}) }], behavior: "allow", destination: "session" };
}

/**
 * Cost-allocation tags from the environment Claude Code was started in:
 * TESSERA_TAGS="project=apollo,ticket=PAY-142,costcenter=CC-120".
 */
export function tagsFromEnv(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 60);
    const v = clean(part.slice(i + 1).trim(), 200);
    if (k && v && k !== "paused" && Object.keys(out).length < 20) out[k] = v;
  }
  return out;
}

function refreshTranscripts(s: SessionState): void {
  s.cursor = advance(s.transcriptPath, s.cursor);
  for (const a of Object.values(s.agents)) if (a.transcriptPath && a.status === "running") a.cursor = advance(a.transcriptPath, a.cursor);
}

function refreshGit(s: SessionState, force = false): void {
  if (!force && Date.now() - s.gitCheckedAt < 10_000) return;
  s.git = gitInfo(s.cwd);
  s.gitCheckedAt = Date.now();
}

function currentAgentId(s: SessionState): string | null {
  return s.runningAgents.at(-1) ?? null;
}

/** Deliveries not acted on yet, remembered so a retried delivery is never applied twice. */
function takeFresh(s: SessionState, deliveries: Delivery[]): Delivery[] {
  const fresh = deliveries.filter((d) => !s.seenDeliveries.includes(d.id));
  for (const d of fresh) s.seenDeliveries.push(d.id);
  if (s.seenDeliveries.length > 200) s.seenDeliveries.splice(0, s.seenDeliveries.length - 200);
  return fresh;
}

const FILTER_NOTE = "Some detail is withheld: a web filter on this network blocks it. The session, its state, cost and timing still show.";

/**
 * Send the session's current snapshot. The snapshot is taken under the lock
 * (with transcripts and git refreshed), the request runs outside it, and the
 * ack is applied under the lock again, so hooks running at the same time never
 * overwrite each other. Returns the deliveries that arrived with the ack.
 */
async function report(cfg: Config, txn: Txn, timeoutMs: number): Promise<{ ack: ReportAck | null; fresh: Delivery[] }> {
  const snap = txn((s) => {
    refreshTranscripts(s);
    refreshGit(s);
    return { report: buildReport(cfg, s), filtered: s.networkFiltered ?? false, retryAt: s.filterRetryAt ?? 0 };
  });
  const r = await sendReport(cfg, snap, timeoutMs);
  const fresh = txn((s) => {
    if (r.filtered !== null) {
      if (r.filtered && !s.networkFiltered) addEvent(s, "note", FILTER_NOTE);
      s.networkFiltered = r.filtered;
      if (r.filtered) s.filterRetryAt = Date.now() + 60_000;
    }
    if (!r.ack) return [];
    const acked = new Set(r.ack.ackedEvents);
    s.outbox = s.outbox.filter((e) => !acked.has(e.id));
    s.lastReportAt = Date.now();
    return takeFresh(s, r.ack.deliveries);
  });
  return { ack: r.ack, fresh };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Report the open prompt, then wait up to `seconds` for Tessera's answer to it.
 * A poll that fails (a proxy hiccup, a timeout) is not a "no": the wait goes
 * on until the deadline, because giving up early is what makes an approval in
 * the console arrive after the terminal has already asked.
 */
async function waitForAnswer(cfg: Config, sid: string, txn: Txn, askId: string, seconds: number): Promise<Delivery | undefined> {
  const found = (list: Delivery[]) => list.find((d) => d.kind === "answer" && d.askId === askId);
  let answer = found((await report(cfg, txn, budget(4000, 10_000))).fresh);
  const deadline = Date.now() + seconds * 1000;
  while (!answer && Date.now() < deadline) {
    const waitS = Math.max(1, Math.min(20, Math.floor((deadline - Date.now()) / 1000)));
    const r = await get<{ deliveries: Delivery[] }>(cfg, `/api/ingest/sessions/${encodeURIComponent(sid)}/deliveries?wait=${waitS}`, (waitS + 10) * 1000);
    if (!r) {
      await sleep(1000);
      continue;
    }
    answer = found(txn((s) => takeFresh(s, r.deliveries)));
  }
  return answer;
}

/**
 * Show a multiple-choice question in Tessera and wait a little for an answer
 * from there. Answered in time, the tool runs with the answer filled in and the
 * terminal never shows the dialog; otherwise the terminal asks as usual.
 */
async function askFromTessera(cfg: Config, sid: string, txn: Txn, input: HookInput, agentId: string | null): Promise<unknown> {
  const detail = askDetail("AskUserQuestion", input.tool_input, undefined, null, null);
  if (!detail.questions.length) return undefined;
  const askId = `${input.tool_use_id ?? "q"}-${Date.now().toString(36)}`;
  const first = detail.questions[0]!;
  txn((s) => {
    s.status = "waiting";
    s.waitReason = "question";
    s.openAsk = {
      id: askId,
      kind: "question",
      createdAt: new Date().toISOString(),
      tool: "AskUserQuestion",
      prompt: detail.questions.length === 1 ? first.question : detail.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n"),
      options: detail.questions.length === 1 ? first.options.map((o) => o.label) : [],
      detail,
    };
    addEvent(s, "wait", `waiting on you: ${clean(first.question, 200)}`, agentId);
  });
  const answer = await waitForAnswer(cfg, sid, txn, askId, cfg.questionWaitSeconds);
  // Either way the dialog is no longer Tessera's to show.
  const answers: Record<string, string> = {};
  let by = "Tessera";
  if (answer) {
    const p = answer.payload as { answers?: Record<string, string>; option?: string | null; text?: string | null; by?: string };
    Object.assign(answers, p.answers ?? {});
    // One question answered with an option or free text; several answered by question text.
    if (!Object.keys(answers).length && (p.option || p.text)) answers[first.question] = String(p.option || p.text);
    by = p.by ?? by;
  }
  txn((s) => {
    s.openAsk = null;
    s.status = "running";
    s.waitReason = null;
    if (Object.keys(answers).length) addEvent(s, "answer", `answered by ${by}: ${clean(Object.values(answers).join(", "), 200)}`, agentId);
  });
  if (!answer || !Object.keys(answers).length) return undefined;
  await post(cfg, `/api/ingest/deliveries/${answer.id}/result`, { result: { applied: true } }, budget(1500, 4000));
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...(input.tool_input ?? {}), answers } } };
}

/**
 * Handle one hook event. Returns what to print to stdout (Claude Code reads it
 * as JSON) and the exit code. Every path is wrapped so a reporter failure can
 * never change what the session does.
 */
export async function handle(cfg: Config | null, event: string, input: HookInput): Promise<{ output: unknown; exitCode: number }> {
  const sid = input.session_id;
  if (!sid) return { output: undefined, exitCode: 0 };
  const txn: Txn = (fn) => updateState(sid, input.cwd ?? null, input.transcript_path ?? null, fn);
  let output: unknown;

  try {
    switch (event) {
      case "SessionStart": {
        txn((s) => {
          if (input.source === "clear") {
            // /clear keeps the session id in some versions; treat it as a continuation.
            s.continuedFrom = s.id;
            s.cursor = newCursor();
          }
          s.status = "waiting";
          s.waitReason = "idle";
          s.tags = { ...s.tags, ...tagsFromEnv(process.env.TESSERA_TAGS) };
          refreshGit(s, true);
          addEvent(s, "session.start", `session started${input.source ? ` (${input.source})` : ""}`);
        });
        break;
      }
      case "UserPromptSubmit": {
        txn((s) => {
          s.status = "running";
          s.waitReason = null;
          s.openAsk = null;
          if (!s.name && input.prompt) s.name = clean(input.prompt.split("\n")[0] ?? "", 80) || null;
          addEvent(s, "turn.start", `prompt: ${clean(input.prompt ?? "", 120)}`);
        });
        break;
      }
      case "PreToolUse": {
        const tool = input.tool_name ?? "tool";
        const summary = toolSummary(tool, input.tool_input);
        const actionId = input.tool_use_id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const agentId = txn((s) => {
          s.status = "running";
          s.waitReason = null;
          const agentId = currentAgentId(s);
          const bucket = agentId ? s.agents[agentId]?.toolCalls : s.toolCalls;
          if (bucket) bucket[tool] = (bucket[tool] ?? 0) + 1;
          startAction(s, actionId, tool, summary, agentId);
          if (tool === "Skill" && typeof input.tool_input?.skill === "string") {
            const a = agentId ? s.agents[agentId] : null;
            if (a) a.skills = [...new Set([...a.skills, String(input.tool_input.skill)])];
          }
          return agentId;
        });
        if (tool === "AskUserQuestion" && cfg) {
          // The agent is asking the person a question. Show it in Tessera and, if someone there
          // answers before the terminal does, hand the answer back so the dialog never appears.
          const answered = await askFromTessera(cfg, sid, txn, input, agentId);
          if (answered) output = answered;
          break;
        }
        if (cfg) {
          const req = decideRequest(sid, tool, input.tool_input);
          let r = await request<DecideResponse>(cfg, "POST", "/api/ingest/decide", req, budget(2500, 6000));
          // A filter that blocks the command text still lets the policy see the program and the paths.
          if (r.kind === "blocked" && req.command) r = await request<DecideResponse>(cfg, "POST", "/api/ingest/decide", { ...req, command: req.command.split(/\s+/)[0] }, budget(2500, 6000));
          const d = r.kind === "ok" ? r.body : null;
          if (d?.decision === "deny" && d.stop) {
            // Someone pressed Stop in Tessera: refuse this call and end the turn, back to the engineer.
            txn((s) => {
              endAction(s, actionId, "denied", d.reason ?? "stopped from Tessera");
              addEvent(s, "note", `Stopped from Tessera: ${d.reason ?? ""}`, agentId);
              s.status = "waiting";
              s.waitReason = "idle";
            });
            output = { continue: false, stopReason: d.reason ?? "Stopped from Tessera.", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Stopped from Tessera." } };
          } else if (d?.decision === "deny") {
            txn((s) => {
              endAction(s, actionId, "denied", d.reason ?? "denied by policy");
              addEvent(s, "note", `Tessera denied ${summary}: ${d.reason ?? "policy"}`, agentId);
            });
            output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Denied by Tessera policy." } };
          } else if (d?.decision === "ask") {
            // Force the permission prompt, which Tessera then shows on the wall and in Slack.
            txn((s) => {
              s.forced = { summary, reason: d.reason ?? "Tessera policy asks for approval.", at: Date.now() };
              addEvent(s, "note", `Tessera requires approval for ${summary}: ${d.reason ?? "policy"}`, agentId);
            });
            output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: d.reason ?? "Tessera policy asks for approval." } };
          }
        }
        break;
      }
      case "PostToolUse": {
        txn((s) => {
          s.status = "running";
          endAction(s, input.tool_use_id, "ok", null, typeof input.duration_ms === "number" ? Math.round(input.duration_ms) : null);
        });
        break;
      }
      case "PostToolUseFailure": {
        txn((s) => {
          const agentId = currentAgentId(s);
          const summary = toolSummary(input.tool_name, input.tool_input);
          const err = clean(String(input.error ?? "failed"), 500);
          endAction(s, input.tool_use_id, "failed", err.slice(0, 300), typeof input.duration_ms === "number" ? Math.round(input.duration_ms) : null);
          addEvent(s, "tool.fail", `${summary} failed: ${err.slice(0, 200)}`, agentId);
          const a = agentId ? s.agents[agentId] : null;
          if (a) a.failure = { class: "tool_error", at: new Date().toISOString(), tool: input.tool_name ?? null, summary: `${summary}: ${err.slice(0, 300)}`, exitCode: null, outputTail: err.split("\n").slice(-12) };
        });
        break;
      }
      case "SubagentStart": {
        txn((s) => {
          const id = input.agent_id ?? `agent-${Date.now()}`;
          const a: AgentState = {
            id,
            parentId: currentAgentId(s),
            kind: "subagent",
            type: input.agent_type ?? null,
            description: null,
            model: null,
            effort: null,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            usageByModel: [],
            context: null,
            toolCalls: {},
            skills: [],
            failure: null,
            promptExcerpt: null,
            answerExcerpt: null,
            transcriptPath: input.agent_transcript_path ?? null,
            cursor: newCursor(),
          };
          s.agents[id] = a;
          s.runningAgents.push(id);
          addEvent(s, "agent.spawn", `spawned ${a.type ?? "agent"}`, id);
        });
        break;
      }
      case "SubagentStop": {
        txn((s) => {
          const id = input.agent_id;
          const a = id ? s.agents[id] : undefined;
          if (a) {
            if (input.agent_transcript_path) a.transcriptPath = input.agent_transcript_path;
            a.cursor = advance(a.transcriptPath, a.cursor);
            a.endedAt = new Date().toISOString();
            a.status = a.failure ? "failed" : "done";
            if (!a.promptExcerpt && a.cursor.firstUserText) a.promptExcerpt = clean(a.cursor.firstUserText, 400);
            addEvent(s, a.status === "failed" ? "agent.fail" : "agent.done", `${a.type ?? "agent"} ${a.status}`, id);
          }
          s.runningAgents = s.runningAgents.filter((x) => x !== id);
        });
        break;
      }
      case "Notification": {
        txn((s) => {
          const t = input.notification_type ?? "";
          if (t === "permission_prompt" || t === "permission_request") {
            s.status = "waiting";
            s.waitReason = "permission";
            if (!s.openAsk) addEvent(s, "wait", `waiting on you: ${clean(input.message ?? "permission", 200)}`);
          } else if (t === "idle_prompt" || t === "idle") {
            s.status = "waiting";
            s.waitReason = "idle";
          } else if (t === "elicitation_dialog") {
            s.status = "waiting";
            s.waitReason = "question";
            addEvent(s, "wait", `waiting on you: ${clean(input.message ?? "input needed", 200)}`);
          }
        });
        break;
      }
      case "PermissionRequest": {
        const tool = input.tool_name ?? "tool";
        const isPlan = tool === "ExitPlanMode";
        const planText = isPlan ? String(input.tool_input?.plan ?? "") : "";
        const askId = `${input.tool_use_id ?? tool}-${Date.now().toString(36)}`;
        const summary = toolSummary(tool, input.tool_input);
        txn((s) => {
          s.status = "waiting";
          s.waitReason = isPlan ? "plan" : "permission";
          // What the agent said just before asking is the best account of why it wants this.
          refreshTranscripts(s);
          const rationale = cfg?.excerpts !== false && s.cursor.lastAssistantText ? clean(s.cursor.lastAssistantText, 1500) : null;
          const forcedBy = s.forced && s.forced.summary === summary && Date.now() - s.forced.at < 60_000 ? s.forced.reason : null;
          s.forced = null;
          const detail = isPlan ? null : askDetail(tool, input.tool_input, input.permission_suggestions, rationale, forcedBy);
          s.openAsk = { id: askId, kind: isPlan ? "plan" : "permission", createdAt: new Date().toISOString(), tool, prompt: clean(isPlan ? planText || "Approve the plan?" : summary, 4000), options: [], detail };
          addEvent(s, "wait", `waiting on you: ${isPlan ? "plan approval" : summary}`);
        });
        if (cfg) {
          const answer = await waitForAnswer(cfg, sid, txn, askId, cfg.permissionWaitSeconds);
          if (answer) {
            const p = answer.payload as { decision?: string; text?: string | null; by?: string; scope?: string; rule?: unknown };
            const allow = p.decision === "allow" || p.decision === "approve";
            // "Allow for this session" also adds a rule, so the runtime stops asking about this pattern.
            const update = allow && p.scope === "session" ? sessionRule(p.rule) : null;
            const ruleText = update?.rules?.[0] ? `${update.rules[0].toolName}${update.rules[0].ruleContent ? `(${update.rules[0].ruleContent})` : ""}` : null;
            txn((s) => {
              addEvent(s, "answer", `${allow ? "allowed" : "denied"} by ${p.by ?? "Tessera"}${ruleText ? ` and allowed ${ruleText} for this session` : ""}${p.text ? `: ${clean(p.text, 200)}` : ""}`);
              s.openAsk = null;
              s.status = "running";
              s.waitReason = null;
            });
            output = {
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: allow
                  ? { behavior: "allow", ...(isPlan ? { updatedInput: input.tool_input ?? {} } : {}), ...(update ? { updatedPermissions: [update] } : {}) }
                  : { behavior: "deny", message: p.text ? `Denied from Tessera by ${p.by ?? "a reviewer"}: ${p.text}` : `Denied from Tessera by ${p.by ?? "a reviewer"}.` },
              },
            };
            await post(cfg, `/api/ingest/deliveries/${answer.id}/result`, { result: { applied: true, decision: p.decision } }, budget(1500, 4000));
          }
        }
        break;
      }
      case "Stop": {
        txn((s) => {
          s.status = "waiting";
          s.waitReason = "idle";
          s.openAsk = null;
          addEvent(s, "turn.end", "turn ended");
        });
        if (cfg) {
          const { fresh } = await report(cfg, txn, budget(3000, 8000));
          const msg = fresh.find((d) => d.kind === "message");
          if (msg && !input.stop_hook_active) {
            const p = msg.payload as { text?: string; by?: string };
            txn((s) => {
              addEvent(s, "answer", `message from ${p.by ?? "Tessera"} delivered`);
              s.status = "running";
              s.waitReason = null;
            });
            output = { decision: "block", reason: `Message from ${p.by ?? "a reviewer"} via Tessera: ${p.text ?? ""}` };
            await post(cfg, `/api/ingest/deliveries/${msg.id}/result`, { result: { applied: true } }, budget(1500, 4000));
          }
          return { output, exitCode: 0 };
        }
        break;
      }
      case "PreCompact": {
        txn((s) => {
          s.blowouts += input.trigger === "auto" ? 1 : 0;
          addEvent(s, input.trigger === "auto" ? "context.blowout" : "context.compact", input.trigger === "auto" ? "context window filled; compacting" : "manual compaction");
        });
        break;
      }
      case "SessionEnd": {
        txn((s) => {
          s.status = "ended";
          s.endedAt = new Date().toISOString();
          s.endReason = input.reason ?? "exit";
          s.openAsk = null;
          for (const a of Object.values(s.agents)) if (a.status === "running") { a.status = "aborted"; a.endedAt = s.endedAt; }
          addEvent(s, "session.end", `session ended (${s.endReason})`);
        });
        // Claude Code gives SessionEnd hooks about 1.5 s by default: one quick attempt.
        if (cfg) await report(cfg, txn, budget(1200, 3000));
        deleteState(sid);
        return { output: undefined, exitCode: 0 };
      }
      default:
        break;
    }

    if (cfg) {
      // Throttle: hooks fire many times a second during tool-heavy turns.
      const heavy = event === "PreToolUse" || event === "PostToolUse";
      const due = txn((s) => !heavy || Date.now() - s.lastReportAt > 1000 || s.outbox.length > 0);
      if (due) await report(cfg, txn, heavy ? budget(2500, 6000) : budget(3000, 8000));
    }
  } catch (e) {
    log(`hook ${event} error: ${(e as Error).stack ?? e}`);
  }
  return { output, exitCode: 0 };
}
