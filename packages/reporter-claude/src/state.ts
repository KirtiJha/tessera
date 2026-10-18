import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEvent, AgentReport, OpenAsk, SessionStatus, WaitReason } from "@tessera/contract";
import { SESSIONS_DIR, ensureDirs } from "./config.js";
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
  gitCheckedAt: number;
  name: string | null;
  continuedFrom: string | null;
  lastReportAt: number;
  /** Delivery ids already acted on, so a retried delivery is not applied twice. */
  seenDeliveries: string[];
  /** Agent ids currently running, in start order (the last is the likely owner of a tool call). */
  runningAgents: string[];
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
    outbox: [],
    seq: 0,
    git: null,
    gitCheckedAt: 0,
    name: null,
    continuedFrom: null,
    lastReportAt: 0,
    seenDeliveries: [],
    runningAgents: [],
  };
}

export function saveState(s: SessionState): void {
  const p = pathFor(s.id);
  const tmp = `${p}.tmp`;
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
