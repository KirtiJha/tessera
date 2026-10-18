import { existsSync, readFileSync, statSync } from "node:fs";
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

export function advance(path: string | null | undefined, cur: TranscriptCursor): TranscriptCursor {
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
  const fd = readFileSync(path);
  const chunk = fd.subarray(cur.offset, size).toString("utf8");
  cur.offset = size;
  const text = cur.partial + chunk;
  const lines = text.split("\n");
  cur.partial = lines.pop() ?? "";
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
  return cur;
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
