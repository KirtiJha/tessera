import { clean, type Report, type ReportAck } from "@tessera/contract";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { VERSION, log, shortHostname, type Config } from "./config.js";
import { contextFill, usageList } from "./transcript.js";
import type { SessionState } from "./state.js";

export function buildReport(cfg: Config, s: SessionState): Report {
  const agents = Object.values(s.agents).map((a) => ({
    id: a.id,
    parentId: a.parentId,
    kind: a.kind,
    type: a.type,
    description: a.description,
    model: a.model ?? a.cursor.model,
    effort: a.effort,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    tokens: a.cursor.tokens,
    usageByModel: usageList(a.cursor),
    context: contextFill(a.cursor),
    toolCalls: a.toolCalls,
    skills: a.skills,
    failure: a.failure,
    promptExcerpt: cfg.excerpts ? a.promptExcerpt : null,
    answerExcerpt: cfg.excerpts ? (a.cursor.lastAssistantText ? clean(a.cursor.lastAssistantText, 400) : a.answerExcerpt) : null,
  }));
  return {
    v: 1,
    sentAt: new Date().toISOString(),
    reporter: { kind: "claude-code-hooks", version: VERSION, schema: "1.0" },
    machine: { hostname: shortHostname(), machineId: cfg.machineId },
    session: {
      id: s.id,
      name: s.name ?? (s.cursor.firstUserText ? clean(s.cursor.firstUserText.split("\n")[0] ?? "", 80) : null),
      cwd: s.cwd,
      model: s.cursor.model,
      effort: null,
      status: s.status,
      waitReason: s.waitReason,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      context: contextFill(s.cursor),
      tokens: s.cursor.tokens,
      usageByModel: usageList(s.cursor),
      ledgerCostUsd: null,
      blowouts: s.blowouts,
      git: s.git,
      filesChanged: [],
      plan: null,
      agents,
      openAsk: s.openAsk,
      tags: s.tags ?? {},
      continuedFrom: s.continuedFrom,
    },
    events: s.outbox.slice(0, 500),
  };
}

export async function post<T>(cfg: Config, path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`${cfg.serverUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`POST ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    log(`POST ${path} failed: ${(e as Error).message}`);
    return null;
  }
}

export async function get<T>(cfg: Config, path: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`${cfg.serverUrl}${path}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Send a snapshot; on success clear the acknowledged events. Returns the ack (deliveries included) or null. */
export async function sendReport(cfg: Config, s: SessionState, timeoutMs = 2500): Promise<ReportAck | null> {
  const ack = await post<ReportAck>(cfg, "/api/ingest/report", buildReport(cfg, s), timeoutMs);
  if (ack) {
    const acked = new Set(ack.ackedEvents);
    s.outbox = s.outbox.filter((e) => !acked.has(e.id));
    s.lastReportAt = Date.now();
  }
  return ack;
}

/** Git facts for the working directory, cheap enough to refresh every 10 s. */
export function gitInfo(cwd: string | null): SessionState["git"] {
  if (!cwd) return null;
  const run = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const top = run(["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = run(["config", "--get", "remote.origin.url"]);
  const repo = remote ? remote.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/") : basename(top);
  const status = run(["status", "--porcelain", "-b"]) ?? "";
  const lines = status.split("\n").filter(Boolean);
  const head = lines.shift() ?? "";
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  const common = run(["rev-parse", "--git-common-dir"]);
  const isWorktree = !!common && common !== ".git" && !common.endsWith("/.git");
  return { repo, branch, worktree: isWorktree ? top : null, ahead, behind, modified: lines.length };
}
