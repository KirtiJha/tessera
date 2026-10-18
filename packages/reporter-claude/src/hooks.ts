import { clean, type DecideRequest, type DecideResponse, type ReportAck } from "@tessera/contract";
import { log, type Config } from "./config.js";
import { addEvent, deleteState, loadState, saveState, type AgentState, type SessionState } from "./state.js";
import { advance, newCursor } from "./transcript.js";
import { get, gitInfo, post, sendReport } from "./transport.js";

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
}

type Delivery = ReportAck["deliveries"][number];

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

async function applyDeliveries(cfg: Config, s: SessionState, deliveries: Delivery[]): Promise<Delivery[]> {
  const fresh = deliveries.filter((d) => !s.seenDeliveries.includes(d.id));
  for (const d of fresh) s.seenDeliveries.push(d.id);
  if (s.seenDeliveries.length > 200) s.seenDeliveries.splice(0, s.seenDeliveries.length - 200);
  return fresh;
}

/**
 * Handle one hook event. Returns what to print to stdout (Claude Code reads it
 * as JSON) and the exit code. Every path is wrapped so a reporter failure can
 * never change what the session does.
 */
export async function handle(cfg: Config | null, event: string, input: HookInput): Promise<{ output: unknown; exitCode: number }> {
  const sid = input.session_id;
  if (!sid) return { output: undefined, exitCode: 0 };
  const s = loadState(sid, input.cwd ?? null, input.transcript_path ?? null);
  let output: unknown;

  try {
    switch (event) {
      case "SessionStart": {
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
        break;
      }
      case "UserPromptSubmit": {
        s.status = "running";
        s.waitReason = null;
        s.openAsk = null;
        if (!s.name && input.prompt) s.name = clean(input.prompt.split("\n")[0] ?? "", 80) || null;
        addEvent(s, "turn.start", `prompt: ${clean(input.prompt ?? "", 120)}`);
        break;
      }
      case "PreToolUse": {
        s.status = "running";
        s.waitReason = null;
        const tool = input.tool_name ?? "tool";
        const agentId = currentAgentId(s);
        const bucket = agentId ? s.agents[agentId]?.toolCalls : s.toolCalls;
        if (bucket) bucket[tool] = (bucket[tool] ?? 0) + 1;
        if (tool === "Skill" && typeof input.tool_input?.skill === "string") {
          const a = agentId ? s.agents[agentId] : null;
          if (a) a.skills = [...new Set([...a.skills, String(input.tool_input.skill)])];
        }
        if (cfg) {
          const d = await post<DecideResponse>(cfg, "/api/ingest/decide", decideRequest(sid, tool, input.tool_input), 1500);
          if (d?.decision === "deny" && d.stop) {
            // Someone pressed Stop in Tessera: refuse this call and end the turn, back to the engineer.
            addEvent(s, "note", `Stopped from Tessera: ${d.reason ?? ""}`, agentId);
            s.status = "waiting";
            s.waitReason = "idle";
            output = { continue: false, stopReason: d.reason ?? "Stopped from Tessera.", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Stopped from Tessera." } };
          } else if (d?.decision === "deny") {
            addEvent(s, "note", `Tessera denied ${toolSummary(tool, input.tool_input)}: ${d.reason ?? "policy"}`, agentId);
            output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Denied by Tessera policy." } };
          } else if (d?.decision === "ask") {
            // Force the permission prompt, which Tessera then shows on the wall and in Slack.
            addEvent(s, "note", `Tessera requires approval for ${toolSummary(tool, input.tool_input)}: ${d.reason ?? "policy"}`, agentId);
            output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: d.reason ?? "Tessera policy asks for approval." } };
          }
        }
        break;
      }
      case "PostToolUse": {
        s.status = "running";
        break;
      }
      case "PostToolUseFailure": {
        const agentId = currentAgentId(s);
        const summary = toolSummary(input.tool_name, input.tool_input);
        const err = clean(String(input.error ?? "failed"), 500);
        addEvent(s, "tool.fail", `${summary} failed: ${err.slice(0, 200)}`, agentId);
        const a = agentId ? s.agents[agentId] : null;
        if (a) a.failure = { class: "tool_error", at: new Date().toISOString(), tool: input.tool_name ?? null, summary: `${summary}: ${err.slice(0, 300)}`, exitCode: null, outputTail: err.split("\n").slice(-12) };
        break;
      }
      case "SubagentStart": {
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
        break;
      }
      case "SubagentStop": {
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
        break;
      }
      case "Notification": {
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
        break;
      }
      case "PermissionRequest": {
        const tool = input.tool_name ?? "tool";
        const isPlan = tool === "ExitPlanMode";
        const planText = isPlan ? String(input.tool_input?.plan ?? "") : "";
        const askId = `${input.tool_use_id ?? tool}-${Date.now().toString(36)}`;
        s.status = "waiting";
        s.waitReason = isPlan ? "plan" : "permission";
        s.openAsk = { id: askId, kind: isPlan ? "plan" : "permission", createdAt: new Date().toISOString(), tool, prompt: clean(isPlan ? planText || "Approve the plan?" : toolSummary(tool, input.tool_input), 4000), options: [] };
        addEvent(s, "wait", `waiting on you: ${isPlan ? "plan approval" : toolSummary(tool, input.tool_input)}`);
        saveState(s);
        if (cfg) {
          const ack = await sendReport(cfg, s, 4000);
          let answer = ack ? (await applyDeliveries(cfg, s, ack.deliveries)).find((d) => d.kind === "answer" && d.askId === askId) : undefined;
          const deadline = Date.now() + cfg.permissionWaitSeconds * 1000;
          while (!answer && Date.now() < deadline) {
            const waitS = Math.max(1, Math.min(20, Math.floor((deadline - Date.now()) / 1000)));
            const r = await get<{ deliveries: Delivery[] }>(cfg, `/api/ingest/sessions/${encodeURIComponent(sid)}/deliveries?wait=${waitS}`, (waitS + 5) * 1000);
            if (!r) break;
            answer = (await applyDeliveries(cfg, s, r.deliveries)).find((d) => d.kind === "answer" && d.askId === askId);
          }
          if (answer) {
            const p = answer.payload as { decision?: string; text?: string | null; by?: string };
            const allow = p.decision === "allow" || p.decision === "approve";
            addEvent(s, "answer", `${allow ? "allowed" : "denied"} by ${p.by ?? "Tessera"}${p.text ? `: ${clean(p.text, 200)}` : ""}`);
            s.openAsk = null;
            s.status = "running";
            s.waitReason = null;
            output = {
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: allow
                  ? { behavior: "allow", ...(isPlan ? { updatedInput: input.tool_input ?? {} } : {}) }
                  : { behavior: "deny", message: p.text ? `Denied from Tessera by ${p.by ?? "a reviewer"}: ${p.text}` : `Denied from Tessera by ${p.by ?? "a reviewer"}.` },
              },
            };
            await post(cfg, `/api/ingest/deliveries/${answer.id}/result`, { result: { applied: true, decision: p.decision } }, 1500);
          }
        }
        break;
      }
      case "Stop": {
        s.status = "waiting";
        s.waitReason = "idle";
        s.openAsk = null;
        refreshGit(s);
        addEvent(s, "turn.end", "turn ended");
        if (cfg) {
          refreshTranscripts(s);
          const ack = await sendReport(cfg, s, 3000);
          const fresh = ack ? await applyDeliveries(cfg, s, ack.deliveries) : [];
          const msg = fresh.find((d) => d.kind === "message");
          if (msg && !input.stop_hook_active) {
            const p = msg.payload as { text?: string; by?: string };
            addEvent(s, "answer", `message from ${p.by ?? "Tessera"} delivered`);
            s.status = "running";
            s.waitReason = null;
            output = { decision: "block", reason: `Message from ${p.by ?? "a reviewer"} via Tessera: ${p.text ?? ""}` };
            await post(cfg, `/api/ingest/deliveries/${msg.id}/result`, { result: { applied: true } }, 1500);
          }
          saveState(s);
          return { output, exitCode: 0 };
        }
        break;
      }
      case "PreCompact": {
        s.blowouts += input.trigger === "auto" ? 1 : 0;
        addEvent(s, input.trigger === "auto" ? "context.blowout" : "context.compact", input.trigger === "auto" ? "context window filled; compacting" : "manual compaction");
        break;
      }
      case "SessionEnd": {
        s.status = "ended";
        s.endedAt = new Date().toISOString();
        s.endReason = input.reason ?? "exit";
        s.openAsk = null;
        for (const a of Object.values(s.agents)) if (a.status === "running") { a.status = "aborted"; a.endedAt = s.endedAt; }
        addEvent(s, "session.end", `session ended (${s.endReason})`);
        if (cfg) {
          refreshTranscripts(s);
          await sendReport(cfg, s, 2000);
        }
        deleteState(sid);
        return { output: undefined, exitCode: 0 };
      }
      default:
        break;
    }

    if (cfg) {
      refreshTranscripts(s);
      refreshGit(s);
      // Throttle: hooks fire many times a second during tool-heavy turns.
      const heavy = event === "PreToolUse" || event === "PostToolUse";
      if (!heavy || Date.now() - s.lastReportAt > 1000 || s.outbox.length > 0) {
        const ack = await sendReport(cfg, s, heavy ? 1500 : 2500);
        if (ack) await applyDeliveries(cfg, s, ack.deliveries);
      }
    }
  } catch (e) {
    log(`hook ${event} error: ${(e as Error).stack ?? e}`);
  }
  try {
    saveState(s);
  } catch (e) {
    log(`state save failed: ${(e as Error).message}`);
  }
  return { output, exitCode: 0 };
}
