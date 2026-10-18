/** Small, dependency-free helpers: argument parsing, tables, colour. */

export interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

/** `a b --x 1 --y=2 --flag -o out` → { _: [a, b], flags: { x: "1", y: "2", flag: true, o: "out" } }. */
export function parseArgs(argv: string[], booleans: string[] = []): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/.exec(a);
    if (!m) {
      out._.push(a);
      continue;
    }
    const key = m[1]!;
    if (m[2] !== undefined) out.flags[key] = m[2];
    else if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) out.flags[key] = true;
    else out.flags[key] = argv[++i]!;
  }
  return out;
}

export const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

const colourOn = () => process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (colourOn() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { dim: wrap("2"), bold: wrap("1"), teal: wrap("36"), amber: wrap("33"), red: wrap("31"), green: wrap("32") };

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Left-aligned columns; columns named in `right` are right-aligned. Widths fit the content, capped. */
export function table(head: string[], rows: string[][], right: number[] = [], max = 48): string {
  const clip = (s: string) => (visible(s) > max ? `${s.slice(0, max - 1)}…` : s);
  const all = [head, ...rows].map((r) => r.map(clip));
  const w = head.map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? ""))));
  const line = (r: string[], isHead = false) =>
    r
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, w[i]! - visible(cell)));
        const v = right.includes(i) ? pad + cell : cell + pad;
        return isHead ? c.dim(v) : v;
      })
      .join("  ")
      .trimEnd();
  return [line(all[0]!, true), ...all.slice(1).map((r) => line(r))].join("\n");
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.floor(h / 24)}d`;
}
