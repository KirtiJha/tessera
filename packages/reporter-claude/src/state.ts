import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, ActivityEvent, AgentReport, ChangedFile, OpenAsk, SessionStatus, WaitReason } from "@tessera/contract";
import { SESSIONS_DIR, ensureDirs, log } from "./config.js";
import { newCursor, type TranscriptCursor } from "./transcript.js";

export interface AgentState extends AgentReport {
  transcriptPath: string | null;
  cursor: TranscriptCursor;
}

export interface SessionState {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  status: SessionStatus;
  waitReason: WaitReason | null;
  openAsk: OpenAsk | null;
  cursor: TranscriptCursor;
  agents: Record<string, AgentState>;
  toolCalls: Record<string, number>;
  blowouts: number;
  /** Events not yet acknowledged by the server. */
  outbox: ActivityEvent[];
  seq: number;
  git: { repo: string | null; branch: string | null; worktree: string | null; ahead: number; behind: number; modified: number } | null;
  /** The working tree's changes against HEAD, refreshed with `git`. */
  filesChanged?: ChangedFile[];
  gitCheckedAt: number;
  name: string | null;
  continuedFrom: string | null;
  /** Cost-allocation tags (TESSERA_TAGS). */
  tags: Record<string, string>;
  lastReportAt: number;
  /** Delivery ids already acted on, so a retried delivery is not applied twice. */
  seenDeliveries: string[];
  /** Agent ids currently running, in start order (the last is the likely owner of a tool call). */
  runningAgents: string[];
  /** The most recent tool calls, newest last, so the wall can show what is happening now. */
  activity: Action[];
  /** The last call Tessera's policy turned into a prompt, so the prompt can say which rule did it. */
  forced: { summary: string; reason: string; at: number } | null;
  /** A web filter on this network blocked the full report; detail is being withheld. */
  networkFiltered?: boolean;
  /** The owner's away setting, as the server last said: decides how long prompts wait for Tessera. */
  presence?: "auto" | "desk" | "away";
  /** The agent whose prompt is open, so its next tool call can close a prompt answered in the terminal. */
  openAskAgent?: string | null;
  /** The keep-alive process for this session, so only one runs. */
  keepalivePid?: number;
  /** When to next try a full report after a block. */
  filterRetryAt?: number;
}

/** Is there state for this session? SessionEnd deletes it, which is how a keep-alive learns the session is over. */
export function hasState(id: string): boolean {
  return existsSync(pathFor(id));
}

function pathFor(id: string): string {
  return join(SESSIONS_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

export function loadState(id: string, cwd: string | null, transcriptPath: string | null): SessionState {
  ensureDirs();
  const p = pathFor(id);
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as SessionState;
      if (transcriptPath && s.transcriptPath !== transcriptPath) {
        s.transcriptPath = transcriptPath;
        s.cursor = newCursor();
      }
      if (cwd) s.cwd = cwd;
      return s;
    } catch {
      /* fall through to a fresh state */
    }
  }
  return {
    id,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    cwd,
    transcriptPath,
    status: "running",
    waitReason: null,
    openAsk: null,
    cursor: newCursor(),
    agents: {},
    toolCalls: {},
    blowouts: 0,
    tags: {},
    outbox: [],
    seq: 0,
    git: null,
    gitCheckedAt: 0,
    name: null,
    continuedFrom: null,
    lastReportAt: 0,
    seenDeliveries: [],
    runningAgents: [],
    activity: [],
    forced: null,
  };
}

/** Record a tool call starting; the matching PostToolUse closes it by id. */
export function startAction(s: SessionState, id: string, tool: string, summary: string, agentId: string | null): void {
  if (!s.activity) s.activity = [];
  s.activity.push({ id, ts: new Date().toISOString(), tool, summary: summary.slice(0, 300), agentId, status: "running", endedAt: null, durationMs: null, error: null });
  if (s.activity.length > 40) s.activity.splice(0, s.activity.length - 40);
}

export function endAction(s: SessionState, id: string | undefined, status: "ok" | "failed" | "denied", error: string | null = null, durationMs: number | null = null): void {
  if (!s.activity) s.activity = [];
  // Without an id (older runtimes), close the newest running call of this session.
  const a = (id ? s.activity.find((x) => x.id === id) : undefined) ?? [...s.activity].reverse().find((x) => x.status === "running");
  if (!a) return;
  a.status = status;
  a.endedAt = new Date().toISOString();
  a.durationMs = durationMs ?? Math.max(0, Date.parse(a.endedAt) - Date.parse(a.ts));
  a.error = error ? error.slice(0, 300) : null;
}

const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold the session's lock. Claude Code runs a hook per tool call and runs them
 * concurrently when calls are parallel, so without this two hooks load the same
 * state, each change it, and the last to save wins: a PostToolUse closing a call
 * is overwritten by a PreToolUse that loaded a moment earlier, and the call
 * stays "running" for ever. The lock is a directory (mkdir is atomic on every
 * platform). A lock older than 15 s belongs to a hook that died and is taken
 * over; after 4 s of waiting the hook proceeds without it rather than lose the event.
 */
export function lockState(id: string): () => void {
  ensureDirs();
  const dir = `${pathFor(id)}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      return () => {
        try {
          rmdirSync(dir);
        } catch {
          /* already released */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(dir);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        log(`state lock for ${id} held for over ${LOCK_WAIT_MS} ms; proceeding without it`);
        return () => {};
      }
      sleepSync(15);
    }
  }
}

/** Load, change and save a session's state under its lock. `fn` must not await: the lock is for the read-modify-write, never for the network. */
export function updateState<T>(id: string, cwd: string | null, transcriptPath: string | null, fn: (s: SessionState) => T): T {
  const unlock = lockState(id);
  try {
    const s = loadState(id, cwd, transcriptPath);
    const out = fn(s);
    saveState(s);
    return out;
  } finally {
    unlock();
  }
}

export function saveState(s: SessionState): void {
  const p = pathFor(s.id);
  // A temp file per writer, so two savers can never rename the same temp file (the ENOENT race in the log).
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
}

export function deleteState(id: string): void {
  try {
    unlinkSync(pathFor(id));
  } catch {
    /* already gone */
  }
}

export function addEvent(s: SessionState, kind: ActivityEvent["kind"], text: string, agentId: string | null = null, data?: Record<string, unknown>): void {
  s.seq++;
  s.outbox.push({ id: `${s.seq}-${Date.now().toString(36)}`, ts: new Date().toISOString(), kind, agentId, text: text.slice(0, 500), ...(data ? { data } : {}) });
  if (s.outbox.length > 500) s.outbox.splice(0, s.outbox.length - 500);
}
