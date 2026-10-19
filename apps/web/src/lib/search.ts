/**
 * Matching for the command palette. Plain substring matching with a small
 * preference order, so results feel predictable: a field that starts with the
 * query beats one with a word that starts with it, which beats one that merely
 * contains it. No fuzzy matching: an operator typing "refund" should not see
 * "re-fund-ed" ranked by edit distance.
 */
export function score(query: string, fields: Array<string | null | undefined>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const v = f.toLowerCase();
    if (v === q) return 4;
    if (v.startsWith(q)) best = Math.max(best, 3);
    else if (v.split(/[\s/._:-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 2);
    else if (v.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

/** The items that match, best first, ties kept in their original order. */
export function rank<T>(query: string, items: T[], fields: (item: T) => Array<string | null | undefined>, limit = 8): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(query, fields(item)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
