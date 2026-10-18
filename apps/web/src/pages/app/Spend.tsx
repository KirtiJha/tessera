import { useEffect, useMemo, useState } from "react";
import { Empty, Panel, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { fmtUsd } from "../../lib/format";

interface Row { day: string; ownerId: string | null; ownerName: string | null; teamName: string | null; costUsd: number; sessions: number }

export function Spend() {
  const [days, setDays] = useState(14);
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    setRows(null);
    void api.get<{ rows: Row[] }>(`/api/admin/spend?days=${days}`).then((r) => setRows(r.rows));
  }, [days]);

  const { byDay, byPerson, total, max } = useMemo(() => {
    const byDay = new Map<string, number>();
    const byPerson = new Map<string, { cost: number; sessions: number; team: string | null }>();
    let total = 0;
    for (const r of rows ?? []) {
      const d = r.day.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + r.costUsd);
      const key = r.ownerName ?? "Unassigned";
      const p = byPerson.get(key) ?? { cost: 0, sessions: 0, team: r.teamName };
      p.cost += r.costUsd;
      p.sessions += r.sessions;
      byPerson.set(key, p);
      total += r.costUsd;
    }
    const dayList: { day: string; cost: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      dayList.push({ day: d, cost: byDay.get(d) ?? 0 });
    }
    return { byDay: dayList, byPerson: [...byPerson.entries()].sort((a, b) => b[1].cost - a[1].cost), total, max: Math.max(0.01, ...dayList.map((d) => d.cost)) };
  }, [rows, days]);

  return (
    <div className="mx-auto max-w-5xl p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Spend</h1>
          <p className="mt-1 text-[14px] text-fog">Estimated from tokens at your model prices. The figure is for steering, never a bill.</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-slate-1 p-1 text-[12.5px]">
          {[7, 14, 30, 90].map((d) => <button key={d} onClick={() => setDays(d)} className={`rounded-md px-2.5 py-1 ${days === d ? "bg-slate-3 text-snow" : "text-fog"}`}>{d} days</button>)}
        </div>
      </div>
      {!rows ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : rows.length === 0 ? (
        <div className="mt-6"><Empty title="No spend recorded yet" body="Spend accrues as sessions report. Check back after the first session runs." /></div>
      ) : (
        <>
          <Panel title={`Per day · ${fmtUsd(total)} in ${days} days`} className="mt-5">
            <div className="flex h-44 items-end gap-[3px]">
              {byDay.map((d) => (
                <div key={d.day} className="group relative flex-1" title={`${d.day}: ${fmtUsd(d.cost, 2)}`}>
                  <div className="w-full rounded-t-sm bg-teal-600 transition-colors group-hover:bg-teal-400" style={{ height: `${Math.max(2, (d.cost / max) * 160)}px` }} />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-fog"><span>{byDay[0]?.day}</span><span>{byDay.at(-1)?.day}</span></div>
          </Panel>
          <Panel title="Per person" className="mt-4">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[11.5px] text-fog"><tr><th className="pb-2 font-medium">Person</th><th className="pb-2 font-medium">Team</th><th className="pb-2 text-right font-medium">Sessions</th><th className="pb-2 text-right font-medium">Est. cost</th><th className="pb-2 pl-4 font-medium">Share</th></tr></thead>
              <tbody className="divide-y divide-line">
                {byPerson.map(([name, p]) => (
                  <tr key={name}>
                    <td className="py-2 font-medium text-snow">{name}</td>
                    <td className="py-2 text-mist">{p.team ?? "—"}</td>
                    <td className="py-2 text-right text-mist">{p.sessions}</td>
                    <td className="py-2 text-right text-snow">{fmtUsd(p.cost)}</td>
                    <td className="py-2 pl-4"><div className="h-1.5 rounded-full bg-slate-3"><div className="h-full rounded-full bg-teal-400" style={{ width: `${total ? (p.cost / total) * 100 : 0}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
