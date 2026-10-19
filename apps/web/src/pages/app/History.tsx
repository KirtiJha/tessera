import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Empty, Input, Select, Spinner, Table, useConfirm, useToast, type Column, type Sort } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, fmtDuration, fmtTokens, fmtUsd, modelShort } from "../../lib/format";

interface Row { id: string; name: string | null; cwd: string | null; model: string | null; startedAt: string; endedAt: string | null; endReason: string | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number | null; repo: string | null; branch: string | null; blowouts: number; ownerName: string | null; ownerId: string | null; hostname: string | null; agentCount: number; failedAgents: number }
interface Person { id: string; name: string; role: string; team: string | null }

const RANGES = [
  ["all", "Any time"],
  ["today", "Today"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
] as const;
type Range = (typeof RANGES)[number][0];
const SORTS = ["started", "name", "owner", "duration", "tokens"] as const;

/** The start of a range as an ISO instant, in the viewer's local day. */
export function rangeStart(range: Range, now = new Date()): string | null {
  if (range === "all") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (range !== "today") d.setDate(d.getDate() - Number.parseInt(range, 10));
  return d.toISOString();
}

/**
 * Ended sessions, newest first. Search, person, time range, sort and page all
 * live in the URL, so a filtered view can be reloaded, shared or linked to.
 */
export function History() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const q = params.get("q") ?? "";
  const owner = params.get("owner") ?? "";
  const range = (RANGES.some(([k]) => k === params.get("range")) ? params.get("range") : "all") as Range;
  const sortKey = (SORTS as readonly string[]).includes(params.get("sort") ?? "") ? (params.get("sort") as Sort["key"]) : "started";
  const dir: Sort["dir"] = params.get("dir") === "asc" ? "asc" : "desc";
  const sort: Sort = { key: sortKey, dir };
  const set = (next: Record<string, string | null>, resetPage = true) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    if (resetPage) p.delete("page");
    setParams(p, { replace: true });
  };

  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    void api.get<{ people: Person[] }>("/api/fleet/people").then((r) => setPeople(r.people)).catch(() => setPeople([]));
  }, []);
  // Any number can be selected: two compare, and an admin can delete what is selected.
  const [picked, setPicked] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const query = useMemo(() => {
    const u = new URLSearchParams({ page: String(page), pageSize: "25", sort: sort.key, dir: sort.dir });
    if (q) u.set("search", q);
    if (owner) u.set("owner", owner);
    const from = rangeStart(range);
    if (from) u.set("from", from);
    return u.toString();
  }, [page, q, owner, range, sort.key, sort.dir]);
  const [data, setData] = useState<{ total: number; pageSize: number; sessions: Row[] } | null>(null);
  useEffect(() => {
    setData(null);
    void api.get<{ total: number; pageSize: number; sessions: Row[] }>(`/api/fleet/history?${query}`).then(setData);
  }, [query]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = !!(q || owner || range !== "all");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!reload) return;
    setData(null);
    void api.get<{ total: number; pageSize: number; sessions: Row[] }>(`/api/fleet/history?${query}`).then(setData);
  }, [reload, query]);

  /** Delete the selected sessions and everything under them. The server refuses anything still live. */
  const deletePicked = async () => {
    const n = picked.length;
    if (!(await confirm({ title: `Delete ${n} session${n === 1 ? "" : "s"} from history?`, body: "Their agents, events, samples and prompts go with them. The audit log keeps a record of the deletion. This cannot be undone.", action: `Delete ${n}`, tone: "danger" }))) return;
    setDeleting(true);
    try {
      const r = await api.post<{ deleted: number; skipped: string[] }>("/api/fleet/sessions/delete", { ids: picked });
      toast(r.skipped.length ? `Deleted ${r.deleted}. ${r.skipped.length} still live and kept; stop or drop them from the wall first.` : `Deleted ${r.deleted} session${r.deleted === 1 ? "" : "s"}.`, r.skipped.length ? "info" : "ok");
      setPicked(r.skipped);
      setReload((x) => x + 1);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not delete.", "error");
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<Row>[] = [
    {
      key: "pick",
      header: data ? <input type="checkbox" aria-label="Select all on this page" checked={data.sessions.length > 0 && data.sessions.every((r) => picked.includes(r.id))} onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...data.sessions.map((r) => r.id)])] : picked.filter((id) => !data.sessions.some((r) => r.id === id)))} /> : <span className="sr-only">Select</span>,
      width: "2.5rem",
      cell: (r) => <input type="checkbox" aria-label={`Select ${r.name ?? r.id}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />,
    },
    {
      key: "name",
      header: "Session",
      sortable: true,
      cell: (r) => (
        <>
          <Link to={`/app/sessions/${encodeURIComponent(r.id)}`} className="font-medium text-snow hover:text-teal-300">{r.name ?? r.repo ?? r.cwd?.split("/").pop() ?? r.id.slice(0, 8)}</Link>
          <div className="text-[11.5px] text-fog">{r.branch ?? r.cwd ?? ""}{r.endReason ? ` · ${r.endReason}` : ""}{r.blowouts ? ` · ${r.blowouts} blowouts` : ""}</div>
        </>
      ),
    },
    { key: "owner", header: "Person", sortable: true, className: "text-mist", cell: (r) => <>{r.ownerName ?? "—"}<div className="text-[11.5px] text-fog">{r.hostname ?? ""}</div></> },
    { key: "model", header: "Model", className: "text-mist", cell: (r) => modelShort(r.model) },
    { key: "started", header: "Started", sortable: true, className: "whitespace-nowrap text-mist", cell: (r) => fmtDate(r.startedAt) },
    { key: "duration", header: "Ran for", sortable: true, className: "text-mist", cell: (r) => (r.endedAt ? fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : "—") },
    { key: "agents", header: "Agents", className: "text-mist", cell: (r) => <>{r.agentCount}{r.failedAgents ? <span className="text-rose-400"> · {r.failedAgents} failed</span> : null}</> },
    { key: "tokens", header: "Tokens", sortable: true, align: "right", className: "text-mist", cell: (r) => fmtTokens(r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite) },
    { key: "cost", header: "Est. cost", align: "right", className: "font-medium text-snow", cell: (r) => fmtUsd(r.costUsd) },
  ];

  return (
    <div className="p-3 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">History</h1>
          <p className="mt-1 text-[14px] text-fog">Every session that has ended or dropped off the wall.</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); set({ q: search.trim() || null }); }} className="flex w-full gap-2 sm:w-auto">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, repo, branch, path" aria-label="Search history" className="w-full sm:w-72" />
          <Button type="submit">Search</Button>
        </form>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select aria-label="Person" value={owner} onChange={(e) => set({ owner: e.target.value || null })} className="h-9 text-[13px]">
            <option value="">Anyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="w-40">
          <Select aria-label="Time range" value={range} onChange={(e) => set({ range: e.target.value === "all" ? null : e.target.value })} className="h-9 text-[13px]">
            {RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </Select>
        </div>
        {filtered ? <button type="button" onClick={() => set({ q: null, owner: null, range: null })} className="text-[12.5px] text-fog hover:text-snow">Clear filters</button> : null}
        {data ? <span className="ml-auto text-[12.5px] text-fog">{data.total} session{data.total === 1 ? "" : "s"}</span> : null}
      </div>
      {!data ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : data.sessions.length === 0 ? (
        <div className="mt-6"><Empty title="Nothing here" body={filtered ? "No ended session matches these filters." : "Sessions move here when they end. Live ones are on the wall."} /></div>
      ) : (
        <>
          <div className="mt-4">
            <Table columns={columns} rows={data.sessions} rowKey={(r) => r.id} sort={sort} onSort={(s) => set({ sort: s.key === "started" && s.dir === "desc" ? null : s.key, dir: s.dir === "desc" ? null : "asc" })} rowClassName={(r) => (picked.includes(r.id) ? "bg-teal-700/10" : undefined)} minWidth={820} caption="Ended sessions" />
          </div>
          <AnimatePresence>
            {picked.length ? (
              <motion.div role="toolbar" aria-label="Selected sessions" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed bottom-5 left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border border-line-2 bg-slate-1 px-4 py-2.5 shadow-2xl">
                <span className="text-[13px] text-mist">{picked.length} selected{picked.length === 1 ? " · pick one more to compare" : ""}</span>
                <Button size="sm" variant="primary" disabled={picked.length !== 2} title={picked.length === 2 ? undefined : "Compare takes exactly two sessions"} onClick={() => nav(`/app/compare?a=${encodeURIComponent(picked[0]!)}&b=${encodeURIComponent(picked[1]!)}`)}>Compare</Button>
                {isAdmin ? <Button size="sm" variant="danger" loading={deleting} onClick={() => void deletePicked()}>Delete {picked.length}</Button> : null}
                <button onClick={() => setPicked([])} className="text-[12.5px] text-fog hover:text-snow">Clear</button>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-fog">
            <Button size="sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) }, false)}>Previous</Button>
            <span>{page} of {pages}</span>
            <Button size="sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) }, false)}>Next</Button>
          </div>
        </>
      )}
    </div>
  );
}
