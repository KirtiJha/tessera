/**
 * A unified diff of two texts, line by line, for the change history: what an
 * Edit or a Write did to a file. Small and dependency-free; texts too large to
 * compare line by line come out as the old lines removed and the new added.
 */

/** Most characters of one patch kept. */
export const PATCH_MAX = 20_000;
/** Beyond this many line pairs, skip the comparison and show a replacement. */
const CELLS_MAX = 1_000_000;
const CONTEXT = 3;

type Op = { k: " " | "-" | "+"; line: string };

function ops(a: string[], b: string[]): Op[] {
  // Common head and tail first: an edit usually changes a few lines in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const mid: Op[] = [];
  if (x.length * y.length > CELLS_MAX) {
    for (const line of x) mid.push({ k: "-", line });
    for (const line of y) mid.push({ k: "+", line });
  } else {
    // Longest common subsequence, then walk it.
    const w = y.length + 1;
    const t = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        mid.push({ k: " ", line: x[i]! });
        i++;
        j++;
      } else if (i < x.length && (j >= y.length || t[(i + 1) * w + j]! >= t[i * w + j + 1]!)) mid.push({ k: "-", line: x[i++]! });
      else mid.push({ k: "+", line: y[j++]! });
    }
  }
  return [...a.slice(0, head).map((line) => ({ k: " " as const, line })), ...mid, ...a.slice(a.length - tail).map((line) => ({ k: " " as const, line }))];
}

const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/**
 * `before` and `after` as unified diff hunks, numbered from `firstLine` (1 for
 * a whole file; where the edited text starts, for an Edit). Returns the patch,
 * capped at PATCH_MAX, and the lines added and removed.
 */
export function unifiedPatch(before: string, after: string, firstLine = 1): { patch: string; added: number; removed: number; truncated: boolean } {
  const all = ops(split(before), split(after));
  const added = all.filter((o) => o.k === "+").length;
  const removed = all.filter((o) => o.k === "-").length;
  const changed = all.map((o, i) => (o.k === " " ? -1 : i)).filter((i) => i >= 0);
  const hunks: string[] = [];
  let i = 0;
  while (i < changed.length) {
    let from = Math.max(0, changed[i]! - CONTEXT);
    let to = Math.min(all.length - 1, changed[i]! + CONTEXT);
    while (i + 1 < changed.length && changed[i + 1]! - CONTEXT <= to + 1) to = Math.min(all.length - 1, changed[++i]! + CONTEXT);
    i++;
    // Line numbers at `from` on each side.
    let o = firstLine;
    let n = firstLine;
    for (let k = 0; k < from; k++) {
      if (all[k]!.k !== "+") o++;
      if (all[k]!.k !== "-") n++;
    }
    const body = all.slice(from, to + 1);
    const oc = body.filter((x) => x.k !== "+").length;
    const nc = body.filter((x) => x.k !== "-").length;
    hunks.push(`@@ -${oc ? o : o - 1},${oc} +${nc ? n : n - 1},${nc} @@`, ...body.map((x) => `${x.k}${x.line}`));
    from = to + 1;
  }
  const text = hunks.join("\n");
  const truncated = text.length > PATCH_MAX;
  return { patch: truncated ? text.slice(0, text.lastIndexOf("\n", PATCH_MAX) + 1 || PATCH_MAX) : text, added, removed, truncated };
}
