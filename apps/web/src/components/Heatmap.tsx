const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * A week-by-hour grid: one cell per weekday and hour, darker where more
 * happened. Hand-drawn SVG; the accent comes from the theme so it reads in
 * light and dark. `cells` is indexed [weekday 0=Mon..6][hour 0..23].
 */
export function Heatmap({ cells, format, ariaLabel }: { cells: number[][]; format: (n: number) => string; ariaLabel: string }) {
  const max = Math.max(1, ...cells.flat());
  const left = 34;
  const top = 16;
  const cw = 26;
  const ch = 16;
  const width = left + 24 * cw;
  const height = top + 7 * ch + 4;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 560 }} role="img" aria-label={ariaLabel} className="text-[9.5px]">
        {Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? <text key={h} x={left + h * cw + cw / 2} y={10} textAnchor="middle" fill="var(--color-fog)">{String(h).padStart(2, "0")}</text> : null))}
        {DAYS.map((d, r) => (
          <g key={d}>
            <text x={left - 6} y={top + r * ch + ch / 2 + 3.5} textAnchor="end" fill="var(--color-fog)">{d}</text>
            {Array.from({ length: 24 }, (_, h) => {
              const v = cells[r]?.[h] ?? 0;
              const a = v ? 0.15 + 0.85 * (v / max) : 0;
              return (
                <rect key={h} x={left + h * cw + 1} y={top + r * ch + 1} width={cw - 2} height={ch - 2} rx={2} fill={v ? "var(--color-teal-400)" : "var(--color-slate-3)"} opacity={v ? a : 0.6}>
                  <title>{`${d} ${String(h).padStart(2, "0")}:00 UTC · ${format(v)}`}</title>
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
