/**
 * Lays the wall out as a flat list of rows for the virtualizer: a header row
 * per group, then that group's sessions in rows of `cols`. Only rows near the
 * viewport are rendered, so the DOM stays small however large the fleet is.
 */

export const CARD_MIN_WIDTH = 330;
export const CARD_GAP = 12;
export const HEADER_HEIGHT = 40;
export const CARD_ROW_HEIGHT = 250;

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

export function estimateRow<T>(row: WallRow<T> | undefined): number {
  return row?.kind === "header" ? HEADER_HEIGHT : CARD_ROW_HEIGHT;
}
