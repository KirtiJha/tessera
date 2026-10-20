import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.js";

/**
 * What the Tessera mod, running inside Claude Code, writes for this session:
 * Claude Code's own context and cost figures, and that it is alive. The hooks
 * reporter reads it into each report; without the mod there is no file and
 * the report carries what the transcript says, as before.
 */
export interface LiveFile {
  v: 1;
  /** When the mod last wrote, ms since the epoch. */
  at: number;
  sessionId: string;
  modVersion: string;
  context: { tokens: number | null; window: number } | null;
  costUsd: number | null;
}

/** The mod refreshes the file every 30 s; older than this, the mod has stopped. */
export const LIVE_FRESH_MS = 90_000;

export const LIVE_DIR = join(HOME, "live");

function pathFor(sessionId: string): string {
  return join(LIVE_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

/** The mod's figures for this session, or null when it is not running for it. */
export function readLive(sessionId: string, now = Date.now()): LiveFile | null {
  let raw: string;
  try {
    raw = readFileSync(pathFor(sessionId), "utf8");
  } catch {
    return null;
  }
  try {
    const f = JSON.parse(raw) as Partial<LiveFile>;
    if (f.v !== 1 || f.sessionId !== sessionId || typeof f.at !== "number" || now - f.at > LIVE_FRESH_MS) return null;
    const window = f.context && typeof f.context.window === "number" && f.context.window > 0 ? f.context.window : null;
    const tokens = f.context && typeof f.context.tokens === "number" && f.context.tokens >= 0 ? f.context.tokens : null;
    return {
      v: 1,
      at: f.at,
      sessionId,
      modVersion: typeof f.modVersion === "string" ? f.modVersion.slice(0, 40) : "unknown",
      context: window ? { tokens, window } : null,
      costUsd: typeof f.costUsd === "number" && f.costUsd >= 0 ? f.costUsd : null,
    };
  } catch {
    // Half written (the mod's write is not atomic): the next report reads it whole.
    return null;
  }
}

export function deleteLive(sessionId: string): void {
  try {
    unlinkSync(pathFor(sessionId));
  } catch {
    /* already gone, or the mod never ran */
  }
}
