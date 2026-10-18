import type { ModelUsage, TokenCounts } from "./report.js";

/**
 * Prices per million tokens, in USD. Tessera prices tokens itself so an
 * organisation's contracted rates (set in the admin UI) move every figure at
 * once. The built-in table carries Anthropic's published list prices for the
 * model families Tessera knows; any model not matched here is "unpriced" and
 * its spend is shown as unknown rather than invented.
 */
export interface ModelPrice {
  /** Matches the start of a model id, e.g. "claude-sonnet-4". Longest prefix wins. */
  prefix: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES_AS_OF = "2026-06-01";

export const BUILTIN_PRICES: ModelPrice[] = [
  { prefix: "claude-opus-4-1", label: "Claude Opus 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-opus-4", label: "Claude Opus 4", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-sonnet-4", label: "Claude Sonnet 4", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { prefix: "claude-3-5-haiku", label: "Claude 3.5 Haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { prefix: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
];

export function findPrice(model: string | null | undefined, table: ModelPrice[] = BUILTIN_PRICES): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: ModelPrice | null = null;
  for (const p of table) {
    if (m.startsWith(p.prefix.toLowerCase()) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

export function priceTokens(t: TokenCounts, p: ModelPrice): number {
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;
}

export interface PricedUsage {
  /** Total priced cost in USD. */
  usd: number;
  /** Models seen that had no price. Spend for them is not in `usd`. */
  unpriced: string[];
}

export function priceUsage(usage: ModelUsage[], table: ModelPrice[] = BUILTIN_PRICES): PricedUsage {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const u of usage) {
    const p = findPrice(u.model, table);
    if (!p) {
      if (u.input + u.output + u.cacheRead + u.cacheWrite > 0) unpriced.add(u.model);
      continue;
    }
    usd += priceTokens(u, p);
  }
  return { usd, unpriced: [...unpriced] };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/**
 * A session's whole usage: its own calls plus every agent's. Reporters send
 * agents' usage separately (subagents keep their own transcripts), so the
 * session's cost is the sum, never one or the other.
 */
export function totalUsage(own: ModelUsage[], agents: { usageByModel: ModelUsage[] }[]): ModelUsage[] {
  const m = new Map<string, ModelUsage>();
  for (const list of [own, ...agents.map((a) => a.usageByModel)]) {
    for (const u of list) {
      const cur = m.get(u.model) ?? { model: u.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      cur.input += u.input;
      cur.output += u.output;
      cur.cacheRead += u.cacheRead;
      cur.cacheWrite += u.cacheWrite;
      m.set(u.model, cur);
    }
  }
  return [...m.values()];
}

