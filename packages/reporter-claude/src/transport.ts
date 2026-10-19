import { clean, type ChangedFile, type Report, type ReportAck } from "@tessera/contract";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME, VERSION, log, shortHostname, type Config } from "./config.js";
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
    claimDeliveries: true,
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
      filesChanged: s.filesChanged ?? [],
      plan: null,
      agents,
      openAsk: s.openAsk,
      tags: s.tags ?? {},
      continuedFrom: s.continuedFrom,
      activity: s.activity ?? [],
      toolCalls: s.toolCalls ?? {},
    },
    events: s.outbox.slice(0, 500),
  };
}

// ---- budgets sized to this network ------------------------------------------
// A hook has a few seconds. Behind a corporate proxy a round trip to the server
// can take 1.5-2 s, so a fixed 1.5 s budget fails almost every time. The typical
// round trip is measured on every successful request and kept per machine.

const LATENCY_PATH = join(HOME, "latency.json");
let ewma: number | null | undefined;

function loadEwma(): number | null {
  if (ewma !== undefined) return ewma;
  try {
    ewma = existsSync(LATENCY_PATH) ? Number((JSON.parse(readFileSync(LATENCY_PATH, "utf8")) as { ewmaMs?: number }).ewmaMs) || null : null;
  } catch {
    ewma = null;
  }
  return ewma;
}

function observe(ms: number): void {
  const prev = loadEwma();
  ewma = prev == null ? ms : Math.round(prev * 0.7 + ms * 0.3);
  try {
    writeFileSync(LATENCY_PATH, JSON.stringify({ ewmaMs: ewma, at: new Date().toISOString() }));
  } catch {
    /* a budget estimate is not worth failing a hook over */
  }
}

/** The typical round trip to the server on this machine, or null before the first successful request. */
export function typicalLatencyMs(): number | null {
  return loadEwma();
}

/** A timeout that fits this network: 2.5× the typical round trip plus half a second, kept within [min, max]. Unknown network: 4 s, within the same bounds. */
export function budget(minMs: number, maxMs: number): number {
  const typical = loadEwma();
  const want = typical == null ? 4000 : Math.round(typical * 2.5 + 500);
  return Math.max(minMs, Math.min(maxMs, want));
}

// ---- requests ------------------------------------------------------------------

export type RequestResult<T> = { kind: "ok"; body: T } | { kind: "blocked" } | { kind: "rejected"; status: number } | { kind: "failed"; error: string };

/** Tessera only ever answers JSON. A 403 carrying an HTML page is a web filter or WAF between this machine and the server refusing the request's content. */
export function isNetworkBlock(status: number, contentType: string | null, text: string): boolean {
  return status === 403 && (/text\/html|xhtml/i.test(contentType ?? "") || /^\s*<(!doctype|html)/i.test(text));
}

export async function request<T>(cfg: Config, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<RequestResult<T>> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${cfg.serverUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      observe(Date.now() - t0);
      return { kind: "ok", body: (await res.json()) as T };
    }
    const text = await res.text();
    if (isNetworkBlock(res.status, res.headers.get("content-type"), text)) {
      log(`${method} ${path} blocked by a web filter on this network (HTTP 403 with an HTML page; not Tessera)`);
      return { kind: "blocked" };
    }
    log(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return { kind: "rejected", status: res.status };
  } catch (e) {
    const err = e as Error;
    const typical = loadEwma();
    log(`${method} ${path} failed: ${err.message}${err.name === "TimeoutError" ? ` (budget ${timeoutMs} ms; typical round trip ${typical == null ? "unknown" : `${typical} ms`})` : ""}`);
    return { kind: "failed", error: err.message };
  }
}

export async function post<T>(cfg: Config, path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  const r = await request<T>(cfg, "POST", path, body, timeoutMs);
  return r.kind === "ok" ? r.body : null;
}

export async function get<T>(cfg: Config, path: string, timeoutMs: number): Promise<T | null> {
  const r = await request<T>(cfg, "GET", path, undefined, timeoutMs);
  return r.kind === "ok" ? r.body : null;
}

// ---- reports, with detail withheld when a filter blocks them --------------------

export const WITHHELD = "withheld: a web filter on this network blocks it";

/**
 * The same report with every free-text field reduced to its shape: tool names
 * without arguments, kinds without text, no excerpts, no command, no diff. The
 * session, its state, tokens, cost, agents and timing all survive, so the wall
 * still shows it; the tag tells the console why the detail is missing.
 */
export function withholdDetail(r: Report): Report {
  const s = r.session;
  return {
    ...r,
    session: {
      ...s,
      name: null,
      activity: s.activity.map((a) => ({ ...a, summary: `${a.tool}(…)`, error: a.error ? WITHHELD : null })),
      openAsk: s.openAsk
        ? {
            ...s.openAsk,
            prompt: `${s.openAsk.tool ?? "tool"}(…) — ${WITHHELD}`,
            detail: s.openAsk.detail ? { ...s.openAsk.detail, command: null, description: null, edits: [], write: null, url: null, paths: [], rationale: null } : null,
          }
        : null,
      agents: s.agents.map((a) => ({ ...a, description: null, promptExcerpt: null, answerExcerpt: null, failure: a.failure ? { ...a.failure, summary: WITHHELD, outputTail: [] } : null })),
      tags: { ...s.tags, "network-filter": "detail withheld" },
    },
    events: r.events.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, agentId: e.agentId, text: e.kind })),
  };
}

export interface ReportSnapshot {
  report: Report;
  /** The session's last report had to withhold detail. */
  filtered: boolean;
  /** When to try a full report again after a block. */
  retryAt: number;
}

/**
 * Send a snapshot. A full report that a filter blocks is sent again with detail
 * withheld; once a session is known to be filtered, the full report is tried
 * again only once a minute, so every hook does not pay for two round trips.
 * Returns the ack, and whether detail was withheld (null when nothing got through).
 */
export async function sendReport(cfg: Config, snap: ReportSnapshot, timeoutMs: number): Promise<{ ack: ReportAck | null; filtered: boolean | null }> {
  if (!snap.filtered || Date.now() >= snap.retryAt) {
    const r = await request<ReportAck>(cfg, "POST", "/api/ingest/report", snap.report, timeoutMs);
    if (r.kind === "ok") return { ack: r.body, filtered: false };
    if (r.kind !== "blocked") return { ack: null, filtered: null };
  }
  const r = await request<ReportAck>(cfg, "POST", "/api/ingest/report", withholdDetail(snap.report), timeoutMs);
  return r.kind === "ok" ? { ack: r.body, filtered: true } : { ack: null, filtered: r.kind === "blocked" ? true : null };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const STATUS: Record<string, ChangedFile["status"]> = { "?": "untracked", A: "added", D: "deleted", R: "renamed", C: "added", M: "modified", T: "modified", U: "modified" };

/** Lines in a small file, for an untracked file's "added" count; a big or unreadable one counts as 0 rather than being read. */
function lineCount(path: string): number {
  try {
    if (statSync(path).size > 512 * 1024) return 0;
    const text = readFileSync(path, "utf8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * What the session has changed in its working tree, against HEAD: each file's
 * status and lines added and removed (staged or not). Untracked files count
 * their lines as added. The biggest changes come first; capped at 200 files.
 */
export function gitFiles(cwd: string | null): ChangedFile[] {
  if (!cwd) return [];
  const status = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (status === null) return [];
  const numstat = new Map<string, { added: number; removed: number }>();
  const ns = (git(cwd, ["diff", "--numstat", "-z", "HEAD"]) ?? "").split("\0");
  for (let i = 0; i < ns.length; i++) {
    const line = ns[i]!;
    if (!line) continue;
    const [a, r, p] = line.split("\t");
    const added = a === "-" ? 0 : Number(a) || 0;
    const removed = r === "-" ? 0 : Number(r) || 0;
    // A rename prints "added\tremoved\t" then the old and new paths as two more fields.
    const path = p || ns[(i += 2)] || "";
    if (path) numstat.set(path, { added, removed });
  }
  const files: ChangedFile[] = [];
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const x = e[0]!;
    const y = e[1]!;
    const path = e.slice(3);
    if (x === "R" || x === "C") i++; // the original path follows
    const st = STATUS[x === " " ? y : x] ?? "modified";
    const n = numstat.get(path);
    files.push({ path: clean(path, 400), status: st, added: n?.added ?? (st === "untracked" ? lineCount(join(cwd, path)) : 0), removed: n?.removed ?? 0 });
  }
  return files.sort((p, q) => q.added + q.removed - (p.added + p.removed)).slice(0, 200);
}

/** Git facts for the working directory, cheap enough to refresh every 10 s. */
export function gitInfo(cwd: string | null): SessionState["git"] {
  if (!cwd) return null;
  const run = (args: string[]) => git(cwd, args)?.trim() ?? null;
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
