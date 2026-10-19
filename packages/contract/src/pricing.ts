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

export const PRICES_AS_OF = "2026-10-19";

/**
 * Anthropic's published list prices (platform.claude.com/docs/en/about-claude/pricing),
 * per million tokens: base input, output, cache read (hits and refreshes) and the
 * 5-minute cache write. Longest matching prefix wins, so "claude-opus-5" does not
 * swallow "claude-opus-5-5". Haiku 5.5 is priced at its up-to-100K-token tier; its
 * over-100K tier is 5× and is not modelled, so long-context Haiku 5.5 is under-priced here.
 */
export const BUILTIN_PRICES: ModelPrice[] = [
  { prefix: "claude-fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { prefix: "claude-fable-5", label: "Claude Fable 5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { prefix: "claude-mythos-5-1", label: "Claude Mythos 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { prefix: "claude-mythos-5", label: "Claude Mythos 5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { prefix: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { prefix: "claude-opus-5", label: "Claude Opus 5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-opus-4-8", label: "Claude Opus 4.8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-opus-4-7", label: "Claude Opus 4.7", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-opus-4-6", label: "Claude Opus 4.6", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-opus-4-5", label: "Claude Opus 4.5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-opus-4-1", label: "Claude Opus 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-opus-4", label: "Claude Opus 4", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  { prefix: "claude-sonnet-5", label: "Claude Sonnet 5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { prefix: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-sonnet-4", label: "Claude Sonnet 4", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { prefix: "claude-haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { prefix: "claude-3-5-haiku", label: "Claude Haiku 3.5", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { prefix: "claude-3-7-sonnet", label: "Claude Sonnet 3.7", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
];

/**
 * The model id as Anthropic names it, whatever platform it came through:
 * "us.anthropic.claude-sonnet-4-5-20250929-v1:0" (Bedrock) and
 * "claude-sonnet-4-5@20250929" (Vertex) both become "claude-sonnet-4-5-...".
 */
export function canonicalModel(model: string): string {
  const m = model.toLowerCase();
  const i = m.indexOf("claude-");
  return i >= 0 ? m.slice(i) : m;
}

export function findPrice(model: string | null | undefined, table: ModelPrice[] = BUILTIN_PRICES): ModelPrice | null {
  if (!model) return null;
  const m = canonicalModel(model);
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

