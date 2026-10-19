/**
 * Lays the wall out as a flat list of rows for the virtualizer: a header row
 * per group, then that group's sessions in rows of `cols`. Only rows near the
 * viewport are rendered, so the DOM stays small however large the fleet is.
 */

export const CARD_MIN_WIDTH = 330;
export const CARD_GAP = 12;
export const HEADER_HEIGHT = 40;
export const CARD_ROW_HEIGHT = 250;
export const COMPACT_ROW_HEIGHT = 186;
export type Density = "comfortable" | "compact";

export type WallRow<T> =
  | { kind: "header"; key: string; group: string; count: number }
  | { kind: "cards"; key: string; group: string; items: T[] };

export function columnsFor(width: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
}

export function buildRows<T extends { id: string }>(groups: [string, T[]][], cols: number): WallRow<T>[] {
  const rows: WallRow<T>[] = [];
  const c = Math.max(1, cols);
  for (const [group, items] of groups) {
    rows.push({ kind: "header", key: `h:${group}`, group, count: items.length });
    for (let i = 0; i < items.length; i += c) {
      const chunk = items.slice(i, i + c);
      // Key by position within the group so a row keeps its DOM node as sessions update in place.
      rows.push({ kind: "cards", key: `r:${group}:${i / c}`, group, items: chunk });
    }
  }
  return rows;
}

export function estimateRow<T>(row: WallRow<T> | undefined, density: Density = "comfortable"): number {
  return row?.kind === "header" ? HEADER_HEIGHT : density === "compact" ? COMPACT_ROW_HEIGHT : CARD_ROW_HEIGHT;
}

/**
 * Where keyboard focus goes next. Arrows move on the grid as laid out (down
 * keeps the column, clamped to a shorter row); Home and End jump; anything
 * else stays. With no current card, the first (or, for End, the last) is it.
 */
export function moveFocus<T extends { id: string }>(rows: WallRow<T>[], current: string | null, key: string): string | null {
  const cards = rows.filter((r): r is Extract<WallRow<T>, { kind: "cards" }> => r.kind === "cards");
  const flat = cards.flatMap((r, ri) => r.items.map((it, ci) => ({ id: it.id, ri, ci })));
  if (!flat.length) return null;
  const pos = flat.findIndex((p) => p.id === current);
  if (pos < 0) return key === "End" ? flat[flat.length - 1]!.id : flat[0]!.id;
  const here = flat[pos]!;
  const inRow = (ri: number) => {
    const row = cards[ri];
    return row ? row.items[Math.min(here.ci, row.items.length - 1)]!.id : here.id;
  };
  switch (key) {
    case "ArrowRight":
      return flat[Math.min(pos + 1, flat.length - 1)]!.id;
    case "ArrowLeft":
      return flat[Math.max(pos - 1, 0)]!.id;
    case "ArrowDown":
      return inRow(here.ri + 1);
    case "ArrowUp":
      return inRow(here.ri - 1);
    case "Home":
      return flat[0]!.id;
    case "End":
      return flat[flat.length - 1]!.id;
    default:
      return here.id;
  }
}
