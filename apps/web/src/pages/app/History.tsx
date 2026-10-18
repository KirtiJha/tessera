import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { Button, Empty, Input, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import { fmtDate, fmtDuration, fmtTokens, fmtUsd, modelShort } from "../../lib/format";

interface Row { id: string; name: string | null; cwd: string | null; model: string | null; startedAt: string; endedAt: string | null; endReason: string | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number | null; repo: string | null; branch: string | null; blowouts: number; ownerName: string | null; hostname: string | null; agentCount: number; failedAgents: number }

export function History() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const nav = useNavigate();
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const [data, setData] = useState<{ total: number; pageSize: number; sessions: Row[] } | null>(null);
  useEffect(() => {
    setData(null);
    void api.get<{ total: number; pageSize: number; sessions: Row[] }>(`/api/fleet/history?page=${page}&pageSize=25${q ? `&search=${encodeURIComponent(q)}` : ""}`).then(setData);
  }, [page, q]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="p-3 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">History</h1>
          <p className="mt-1 text-[14px] text-fog">Every session that has ended or dropped off the wall, newest first.</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQ(search); }} className="flex w-full gap-2 sm:w-auto">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, repo, branch, path" className="w-full sm:w-72" />
          <Button type="submit">Search</Button>
        </form>
      </div>
      {!data ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : data.sessions.length === 0 ? (
        <div className="mt-6"><Empty title="Nothing here yet" body={q ? "No ended session matches that search." : "Sessions move here when they end. Live ones are on the wall."} /></div>
      ) : (
        <>
          <div className="mt-5 overflow-hidden rounded-xl border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-slate-1 text-left text-[11.5px] text-fog">
                <tr><th className="w-10 py-2.5 pl-4"><span className="sr-only">Compare</span></th><th className="px-3 py-2.5 font-medium">Session</th><th className="px-3 py-2.5 font-medium">Person</th><th className="px-3 py-2.5 font-medium">Model</th><th className="px-3 py-2.5 font-medium">Started</th><th className="px-3 py-2.5 font-medium">Ran for</th><th className="px-3 py-2.5 font-medium">Agents</th><th className="px-3 py-2.5 text-right font-medium">Tokens</th><th className="px-4 py-2.5 text-right font-medium">Est. cost</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.sessions.map((r) => (
                  <tr key={r.id} className={picked.includes(r.id) ? "bg-teal-700/10" : "hover:bg-slate-1"}>
                    <td className="py-2.5 pl-4"><input type="checkbox" aria-label={`Select ${r.name ?? r.id} to compare`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td className="px-3 py-2.5">
                      <Link to={`/app/sessions/${encodeURIComponent(r.id)}`} className="font-medium text-snow hover:text-teal-300">{r.name ?? r.repo ?? r.cwd?.split("/").pop() ?? r.id.slice(0, 8)}</Link>
                      <div className="text-[11.5px] text-fog">{r.branch ?? r.cwd ?? ""}{r.endReason ? ` · ${r.endReason}` : ""}{r.blowouts ? ` · ${r.blowouts} blowouts` : ""}</div>
                    </td>
                    <td className="px-3 py-2.5 text-mist">{r.ownerName ?? "—"}<div className="text-[11.5px] text-fog">{r.hostname ?? ""}</div></td>
                    <td className="px-3 py-2.5 text-mist">{modelShort(r.model)}</td>
                    <td className="px-3 py-2.5 text-mist">{fmtDate(r.startedAt)}</td>
                    <td className="px-3 py-2.5 text-mist">{r.endedAt ? fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : "—"}</td>
                    <td className="px-3 py-2.5 text-mist">{r.agentCount}{r.failedAgents ? <span className="text-rose-400"> · {r.failedAgents} failed</span> : null}</td>
                    <td className="px-3 py-2.5 text-right text-mist">{fmtTokens(r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-snow">{fmtUsd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <AnimatePresence>
            {picked.length ? (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-line-2 bg-slate-1 px-4 py-2.5 shadow-2xl">
                <span className="text-[13px] text-mist">{picked.length === 1 ? "Pick one more to compare" : "2 sessions selected"}</span>
                <Button size="sm" variant="primary" disabled={picked.length < 2} onClick={() => nav(`/app/compare?a=${encodeURIComponent(picked[0]!)}&b=${encodeURIComponent(picked[1]!)}`)}>Compare</Button>
                <button onClick={() => setPicked([])} className="text-[12.5px] text-fog hover:text-snow">Clear</button>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="mt-3 flex items-center justify-between text-[13px] text-fog">
            <span>{data.total} sessions</span>
            <div className="flex items-center gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span>{page} of {pages}</span><Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        </>
      )}
    </div>
  );
}
