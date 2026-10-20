import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { ContextFill, ModelUsage, TokenCounts } from "@tessera/contract";

/**
 * Reads a Claude Code JSONL transcript for what the hooks do not carry:
 * token usage per model, the current model, and how full the context is.
 * Parsing is incremental: the caller keeps the byte offset and the running
 * totals between hook calls.
 */
export interface TranscriptCursor {
  offset: number;
  partial: string;
  tokens: TokenCounts;
  usageByModel: Record<string, TokenCounts>;
  model: string | null;
  /** Prompt size of the latest assistant turn: what the context holds now. */
  contextUsed: number;
  compactions: number;
  lastAssistantText: string | null;
  firstUserText: string | null;
}

export function newCursor(): TranscriptCursor {
  return { offset: 0, partial: "", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageByModel: {}, model: null, contextUsed: 0, compactions: 0, lastAssistantText: null, firstUserText: null };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text").map((c) => String((c as { text?: string }).text ?? ""));
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/** Read at most this much of a transcript per hook. A long session's transcript runs to hundreds of MB; the rest is read on later hooks. */
export const READ_BUDGET_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
/** And for at most this long: a cold disk (or a scanner inspecting a big file) can make even a bounded read slow. */
export const READ_BUDGET_MS = 1500;

/**
 * Read what was appended since the cursor, in chunks, never more than
 * `budget` bytes per call: the hook has seconds, and runs under the session's
 * lock, so a 600 MB transcript must not be read in one go (it cannot be: a
 * string that large does not fit). Totals catch up over the next few hooks.
 */
export function advance(path: string | null | undefined, cur: TranscriptCursor, budget = READ_BUDGET_BYTES): TranscriptCursor {
  if (!path || !existsSync(path)) return cur;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return cur;
  }
  if (size < cur.offset) {
    // Truncated or rewritten (a /clear): start over.
    cur = newCursor();
  }
  if (size === cur.offset) return cur;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return cur;
  }
  try {
    const end = Math.min(size, cur.offset + budget);
    const deadline = Date.now() + READ_BUDGET_MS;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    while (cur.offset < end && Date.now() < deadline) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK_BYTES, end - cur.offset), cur.offset);
      if (n <= 0) break;
      // Consume whole lines only: a newline byte never falls inside a UTF-8 character, so the
      // cut is always clean, and whatever follows the last newline is read again next time.
      const nl = buf.lastIndexOf(10, n - 1);
      if (nl >= 0) {
        parseLines(cur, buf.subarray(0, nl + 1).toString("utf8"));
        cur.offset += nl + 1;
      } else if (n === CHUNK_BYTES) {
        // A whole chunk without a newline: a line too long to be usage data. Remember we are inside it and move on.
        cur.partial = SKIP;
        cur.offset += n;
      } else {
        // The last line is still being written; read it next time.
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  return cur;
}

const SKIP = "\u0000skip";

/** Parse complete lines. If the previous chunk ended inside an over-long line, its tail (up to the first newline) is dropped. */
function parseLines(cur: TranscriptCursor, text: string): void {
  // State saved by an older reporter may hold the start of a line as text; it belongs in front.
  const lines = (cur.partial && cur.partial !== SKIP ? cur.partial + text : text).split("\n");
  lines.pop(); // the empty string after the final newline
  if (cur.partial === SKIP) lines.shift();
  cur.partial = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = row.type as string | undefined;
    const msg = row.message as { role?: string; model?: string; usage?: Usage; content?: unknown } | undefined;
    if (type === "assistant" && msg) {
      const u = msg.usage ?? {};
      const t: TokenCounts = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      if (t.input + t.output + t.cacheRead + t.cacheWrite > 0) {
        cur.tokens = { input: cur.tokens.input + t.input, output: cur.tokens.output + t.output, cacheRead: cur.tokens.cacheRead + t.cacheRead, cacheWrite: cur.tokens.cacheWrite + t.cacheWrite };
        const model = msg.model ?? cur.model ?? "unknown";
        const prev = cur.usageByModel[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        cur.usageByModel[model] = { input: prev.input + t.input, output: prev.output + t.output, cacheRead: prev.cacheRead + t.cacheRead, cacheWrite: prev.cacheWrite + t.cacheWrite };
        cur.contextUsed = t.input + t.cacheRead + t.cacheWrite + t.output;
      }
      if (msg.model) cur.model = msg.model;
      const tx = textOf(msg.content);
      if (tx) cur.lastAssistantText = tx;
    } else if (type === "user" && msg && cur.firstUserText === null) {
      const tx = textOf(msg.content);
      if (tx && !tx.startsWith("<")) cur.firstUserText = tx;
    } else if (type === "system" && typeof row.subtype === "string" && row.subtype.includes("compact")) {
      cur.compactions++;
    } else if (row.isCompactSummary === true || (typeof row.subtype === "string" && row.subtype === "compact_boundary")) {
      cur.compactions++;
    }
  }
}

export function usageList(cur: TranscriptCursor): ModelUsage[] {
  return Object.entries(cur.usageByModel).map(([model, t]) => ({ model, ...t }));
}

export function contextWindowFor(model: string | null): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes("[1m]") || m.includes("-1m")) return 1_000_000;
  return 200_000;
}

export function contextFill(cur: TranscriptCursor): ContextFill | null {
  if (!cur.contextUsed) return null;
  return { used: cur.contextUsed, window: contextWindowFor(cur.model) };
}
