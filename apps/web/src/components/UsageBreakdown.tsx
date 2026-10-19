import type { SessionView } from "@tessera/contract";
import { useMemo } from "react";
import { fmtTokens, fmtUsd, modelShort } from "../lib/format";

const PARTS = [
  { key: "cacheRead", label: "cache read", tone: "bg-teal-700" },
  { key: "input", label: "input", tone: "bg-teal-400" },
  { key: "cacheWrite", label: "cache write", tone: "bg-violet-400" },
  { key: "output", label: "output", tone: "bg-amber-400" },
] as const;

/**
 * Where the tokens went: per model, how much was read from cache versus sent
 * fresh versus generated, and the cache hit rate that follows; per agent, the
 * cost. A low hit rate on a long session is the single biggest avoidable cost.
 */
export function UsageBreakdown({ s }: { s: SessionView }) {
  const models = useMemo(() => {
    const m = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    for (const u of [...s.usageByModel, ...s.agents.flatMap((a) => a.usageByModel)]) {
      const k = u.model;
      const cur = m.get(k) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      m.set(k, { input: cur.input + u.input, output: cur.output + u.output, cacheRead: cur.cacheRead + u.cacheRead, cacheWrite: cur.cacheWrite + u.cacheWrite });
    }
    return [...m.entries()].map(([model, t]) => ({ model, t, total: t.input + t.output + t.cacheRead + t.cacheWrite })).sort((a, b) => b.total - a.total);
  }, [s]);
  const all = models.reduce((acc, m) => ({ input: acc.input + m.t.input, output: acc.output + m.t.output, cacheRead: acc.cacheRead + m.t.cacheRead, cacheWrite: acc.cacheWrite + m.t.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const promptSide = all.input + all.cacheRead + all.cacheWrite;
  const hitRate = promptSide ? all.cacheRead / promptSide : null;
  const agents = [...s.agents].filter((a) => a.costUsd !== null && a.costUsd > 0).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 8);
  const maxAgent = Math.max(0.0001, ...agents.map((a) => a.costUsd ?? 0));

  if (!models.length) return <p className="text-[12.5px] text-fog">No token usage reported yet.</p>;
  return (
    <div className="space-y-4 text-[12.5px]">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-mist">Cache hit rate</span>
          <span className={`text-[18px] font-semibold ${hitRate === null ? "text-fog" : hitRate >= 0.7 ? "text-teal-300" : hitRate >= 0.4 ? "text-amber-400" : "text-rose-400"}`}>{hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`}</span>
        </div>
        <p className="text-[11.5px] text-fog">Share of prompt tokens served from the cache. Cache reads cost a tenth of fresh input or less; a low rate on a long session is the biggest avoidable cost.</p>
      </div>
      <ul className="space-y-2.5">
        {models.map(({ model, t, total }) => (
          <li key={model}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-snow">{modelShort(model)}</span>
              <span className="text-fog">{fmtTokens(total)} tokens{s.unpricedModels.includes(model) ? " · unpriced" : ""}</span>
            </div>
            <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-3" role="img" aria-label={`${modelShort(model)}: ${PARTS.map((p) => `${p.label} ${fmtTokens(t[p.key])}`).join(", ")}`}>
              {PARTS.map((p) => (total ? <div key={p.key} className={p.tone} style={{ width: `${(t[p.key] / total) * 100}%` }} title={`${p.label}: ${fmtTokens(t[p.key])}`} /> : null))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fog">
        {PARTS.map((p) => <span key={p.key}><i className={`mr-1 inline-block h-2 w-3 rounded-sm align-middle ${p.tone}`} />{p.label} {fmtTokens(all[p.key])}</span>)}
      </div>
      {agents.length ? (
        <div>
          <div className="mb-1.5 text-mist">Cost by agent</div>
          <ul className="space-y-1.5">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span className="w-28 truncate text-mist" title={a.description ?? undefined}>{a.kind === "orchestrator" ? "orchestrator" : (a.type ?? a.kind)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-3"><div className="h-full rounded-full bg-teal-400" style={{ width: `${((a.costUsd ?? 0) / maxAgent) * 100}%` }} /></div>
                <span className="w-16 text-right text-snow">{fmtUsd(a.costUsd, 3)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
