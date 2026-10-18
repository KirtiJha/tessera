import { BUILTIN_PRICES, type ModelPrice, priceUsage, type ModelUsage } from "@tessera/contract";
import { pool } from "../db/pool.js";

const cache = new Map<string, { table: ModelPrice[]; until: number }>();

/** Built-in list prices with the org's overrides laid over them (same prefix replaces). */
export async function priceTableFor(orgId: string): Promise<ModelPrice[]> {
  const hit = cache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.table;
  const r = await pool.query<{ prefix: string; label: string; input: number; output: number; cache_read: number; cache_write: number }>(
    "SELECT prefix, label, input, output, cache_read, cache_write FROM model_prices WHERE org_id = $1",
    [orgId],
  );
  const overrides = new Map(r.rows.map((x) => [x.prefix.toLowerCase(), x]));
  const table: ModelPrice[] = BUILTIN_PRICES.filter((p) => !overrides.has(p.prefix.toLowerCase()));
  for (const o of r.rows) table.push({ prefix: o.prefix, label: o.label, input: o.input, output: o.output, cacheRead: o.cache_read, cacheWrite: o.cache_write });
  cache.set(orgId, { table, until: Date.now() + 60_000 });
  return table;
}

export function invalidatePrices(orgId: string): void {
  cache.delete(orgId);
}

export function priceFor(usage: ModelUsage[], table: ModelPrice[]): { usd: number | null; unpriced: string[] } {
  const r = priceUsage(usage, table);
  const anyTokens = usage.some((u) => u.input + u.output + u.cacheRead + u.cacheWrite > 0);
  if (!anyTokens) return { usd: 0, unpriced: [] };
  // If nothing could be priced at all, the figure is unknown rather than zero.
  if (r.usd === 0 && r.unpriced.length > 0) return { usd: null, unpriced: r.unpriced };
  return { usd: r.usd, unpriced: r.unpriced };
}
