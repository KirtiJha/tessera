import { Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";

export interface Column {
  key: string;
  label: string;
  value: number;
  flagged?: boolean;
  detail?: string;
}

/** Round the axis maximum up to a clean number: 1, 2, 2.5, 5 × 10^n. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * One series of columns over time. Columns are at most 24px wide with a 4px
 * rounded top on a single baseline; each column's whole slot is its hover and
 * focus target, and the tooltip leads with the value. Flagged columns carry an
 * icon and a label, never colour alone.
 */
export function ColumnChart({ data, format, height = 200, ariaLabel }: { data: Column[]; format: (n: number) => string; height?: number; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const max = useMemo(() => niceMax(Math.max(0, ...data.map((d) => d.value))), [data]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const n = Math.max(1, data.length);
  const plotH = height - 22;
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <div className="relative w-14 shrink-0" style={{ height: plotH }} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-fog" style={{ top: plotH - (t / max) * plotH }}>{format(t)}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" role="list" aria-label={ariaLabel} style={{ height: plotH }} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => <div key={t} className="absolute inset-x-0 h-px bg-line" style={{ top: plotH - (t / max) * plotH }} aria-hidden="true" />)}
          <div className="absolute inset-0 flex">
            {data.map((d, i) => {
              const barH = d.value > 0 ? Math.max(2, (d.value / max) * plotH) : 0;
              return (
                <div
                  key={d.key}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${d.label}: ${format(d.value)}${d.flagged ? ", unusually high" : ""}${d.detail ? `, ${d.detail}` : ""}`}
                  className="relative flex h-full flex-1 items-end justify-center outline-none"
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  {d.flagged && barH ? <TriangleAlert size={12} className="absolute text-amber-400" style={{ bottom: barH + 4 }} aria-hidden="true" /> : null}
                  <div
                    className={`transition-[height,background-color] duration-300 ${d.flagged ? "bg-amber-400" : hover === i ? "bg-teal-300" : "bg-teal-400"}`}
                    style={{ height: barH, width: `min(24px, calc(100% - 2px))`, borderRadius: "4px 4px 0 0" }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="ml-14 mt-1.5 flex justify-between text-[11px] text-fog" aria-hidden="true">
        <span>{data[0]?.label}</span>
        {n > 2 ? <span>{data[Math.floor(n / 2)]?.label}</span> : null}
        <span>{data.at(-1)?.label}</span>
      </div>
      {h && hover !== null ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line-2 bg-slate-1 px-2.5 py-1.5 shadow-xl"
          style={{ left: `calc(3.5rem + (100% - 3.5rem) * ${(hover + 0.5) / n})`, top: Math.max(0, plotH - (h.value / max) * plotH - 58) }}
        >
          <div className="text-[13px] font-semibold tabular-nums text-snow">{format(h.value)}</div>
          <div className="text-[11.5px] text-fog">{h.label}{h.detail ? ` · ${h.detail}` : ""}</div>
          {h.flagged ? <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-amber-400"><TriangleAlert size={11} /> Unusually high for the fortnight before</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Ranked horizontal bars with the value at the tip and a share column. */
/** Change against the period before, as a chip: spend going up is amber, down is teal, nothing before is "new". */
export function Change({ now, before }: { now: number; before: number }) {
  if (before <= 0) return now > 0 ? <span className="rounded bg-slate-3 px-1 text-[10.5px] text-mist" title="Nothing in the period before">new</span> : null;
  const c = (now - before) / before;
  if (Math.abs(c) < 0.005) return <span className="text-[11px] text-fog" title="Same as the period before">±0%</span>;
  return <span className={`text-[11px] ${c > 0 ? "text-amber-400" : "text-teal-300"}`} title={`Period before: ${before.toFixed(2)}`}>{c > 0 ? "▲" : "▼"}{Math.round(Math.abs(c) * 100)}%</span>;
}

export function BarList({ rows, format, total, sub }: { rows: { key: string; value: number; sub?: string; prev?: number; href?: string }[]; format: (n: number) => string; total: number; sub?: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5" aria-label={sub}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-3 text-[13px]">
          {r.href ? <Link to={r.href} className="truncate text-snow hover:text-teal-300 hover:underline" title={`Open ${r.key}`}>{r.key}</Link> : <span className="truncate text-snow" title={r.key}>{r.key}</span>}
          <span className="flex items-center gap-2">
            <span className="h-2.5 rounded-r-[4px] bg-teal-400 transition-[width] duration-500" style={{ width: `${Math.max(0.5, (r.value / max) * 100)}%` }} />
          </span>
          <span className="whitespace-nowrap text-right tabular-nums">
            <span className="font-medium text-snow">{format(r.value)}</span>
            {r.prev !== undefined ? <span className="ml-1.5"><Change now={r.value} before={r.prev} /></span> : null}
            <span className="ml-2 text-[11.5px] text-fog">{total ? `${Math.round((r.value / total) * 100)}%` : ""}{r.sub ? ` · ${r.sub}` : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
