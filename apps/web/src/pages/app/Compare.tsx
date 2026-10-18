import type { SessionView } from "@tessera/contract";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { KIND, StateShape } from "../../components/SessionCard";
import { Empty, Input, Panel, Spinner } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { sessionKind, sessionLabel, useFleet } from "../../lib/fleet";
import { fmtDate, fmtDuration, fmtTokens, fmtUsd, modelShort } from "../../lib/format";

interface Detail {
  session: SessionView;
  asks: { createdAt: string; closedAt: string | null; outcome: string | null }[];
}
interface Pick { id: string; label: string; sub: string }

const total = (t: SessionView["tokens"]) => t.input + t.output + t.cacheRead + t.cacheWrite;

function facts(d: Detail) {
  const s = d.session;
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.parse(s.lastSeenAt);
  const ms = Math.max(0, end - Date.parse(s.startedAt));
  const agents = s.agents.filter((a) => a.kind !== "orchestrator");
  const tools: Record<string, number> = {};
  for (const a of s.agents) for (const [k, n] of Object.entries(a.toolCalls)) tools[k] = (tools[k] ?? 0) + n;
  const answered = d.asks.filter((a) => a.closedAt);
  const waitMs = answered.reduce((n, a) => n + (Date.parse(a.closedAt!) - Date.parse(a.createdAt)), 0);
  const agentTokens = s.agents.reduce((n, a) => n + total(a.tokens), 0);
  const tokens = total(s.tokens) + agentTokens;
  return {
    ms,
    cost: s.costUsd ?? 0,
    costPerHour: ms > 60_000 && s.costUsd !== null ? (s.costUsd / ms) * 3_600_000 : null,
    tokens,
    cacheShare: tokens ? (s.tokens.cacheRead + s.agents.reduce((n, a) => n + a.tokens.cacheRead, 0)) / tokens : 0,
    agents: agents.length,
    failed: agents.filter((a) => a.status === "failed").length,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    tools,
    blowouts: s.blowouts,
    asks: d.asks.length,
    meanWait: answered.length ? waitMs / answered.length : null,
    files: s.filesChanged.length,
    lines: s.filesChanged.reduce((n, f) => n + f.added + f.removed, 0),
  };
}

function Bar({ v, max, tone }: { v: number; max: number; tone: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-3">
      <motion.div className="h-full rounded-full" style={{ background: tone }} initial={{ width: 0 }} animate={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} />
    </div>
  );
}

function Row({ label, a, b, fmt, lowerIsBetter = true }: { label: string; a: number | null; b: number | null; fmt: (n: number) => string; lowerIsBetter?: boolean }) {
  const max = Math.max(a ?? 0, b ?? 0);
  const ratio = a && b ? Math.max(a, b) / Math.min(a, b) : null;
  const bigger = a !== null && b !== null && a !== b ? (a > b ? "a" : "b") : null;
  const chip = (side: "a" | "b") =>
    ratio && ratio >= 1.15 && bigger === side ? <span className={`ml-2 rounded px-1.5 text-[11px] font-medium ${lowerIsBetter ? "bg-rose-600/15 text-rose-400" : "bg-teal-700/40 text-teal-300"}`}>{ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}×</span> : null;
  const cell = (v: number | null, side: "a" | "b", tone: string) => (
    <div className="min-w-0">
      <div className="flex items-baseline text-[14px] font-semibold tabular-nums text-snow">{v === null ? <span className="font-normal text-fog">—</span> : fmt(v)}{chip(side)}</div>
      {v !== null ? <div className="mt-1.5"><Bar v={v} max={max} tone={tone} /></div> : null}
    </div>
  );
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-5 border-b border-line py-3 last:border-b-0">
      <div className="text-[12.5px] text-fog">{label}</div>
      {cell(a, "a", "var(--color-teal-400)")}
      {cell(b, "b", "var(--color-violet-400)")}
    </div>
  );
}

function Picker({ exclude, onPick }: { exclude: string; onPick: (id: string) => void }) {
  const { sessions } = useFleet();
  const [q, setQ] = useState("");
  const [hist, setHist] = useState<Pick[]>([]);
  useEffect(() => {
    void api.get<{ sessions: { id: string; name: string | null; repo: string | null; cwd: string | null; ownerName: string | null; startedAt: string }[] }>(`/api/fleet/history?pageSize=50${q ? `&search=${encodeURIComponent(q)}` : ""}`).then((r) =>
      setHist(r.sessions.map((x) => ({ id: x.id, label: x.name ?? x.repo ?? x.cwd?.split("/").pop() ?? x.id.slice(0, 8), sub: `${x.ownerName ?? "—"} · ended · ${fmtDate(x.startedAt)}` }))),
    );
  }, [q]);
  const live: Pick[] = [...sessions.values()].filter((s) => !q || sessionLabel(s).toLowerCase().includes(q.toLowerCase())).map((s) => ({ id: s.id, label: sessionLabel(s), sub: `${s.ownerName ?? "—"} · live · ${fmtDate(s.startedAt)}` }));
  const list = [...live, ...hist].filter((p) => p.id !== exclude).slice(0, 40);
  return (
    <div>
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions by name, repo or branch" />
      <ul className="mt-3 max-h-[420px] divide-y divide-line overflow-auto rounded-xl border border-line">
        {list.map((p) => (
          <li key={p.id}><button onClick={() => onPick(p.id)} className="w-full px-3 py-2.5 text-left hover:bg-slate-2"><div className="text-[13.5px] text-snow">{p.label}</div><div className="text-[11.5px] text-fog">{p.sub}</div></button></li>
        ))}
        {list.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-fog">No sessions match.</li> : null}
      </ul>
    </div>
  );
}

/** Two sessions side by side: what each cost, how long it ran, how much it asked of people, what it did. */
export function Compare() {
  const [params, setParams] = useSearchParams();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  const [da, setDa] = useState<Detail | null>(null);
  const [db, setDb] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    const load = (id: string, set: (d: Detail | null) => void) => (id ? api.get<Detail>(`/api/fleet/sessions/${encodeURIComponent(id)}`).then(set).catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load a session.")) : set(null));
    void load(a, setDa);
    void load(b, setDb);
  }, [a, b]);
  const fa = useMemo(() => (da ? facts(da) : null), [da]);
  const fb = useMemo(() => (db ? facts(db) : null), [db]);
  const toolNames = useMemo(() => {
    const all = new Map<string, number>();
    for (const f of [fa, fb]) if (f) for (const [k, n] of Object.entries(f.tools)) all.set(k, (all.get(k) ?? 0) + n);
    return [...all.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
  }, [fa, fb]);

  if (!a) return <div className="mx-auto max-w-2xl p-3 sm:p-5"><Empty title="Pick a session to compare" body="Open a session and choose Compare, or pick two from History." /></div>;
  if (err) return <div className="p-6 text-[14px] text-rose-400">{err}</div>;

  const head = (d: Detail | null, tone: string, side: "a" | "b") => {
    if (!d) return <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-line-2 text-[13px] text-fog">{side === "b" ? "Choose a session below" : <Spinner />}</div>;
    const s = d.session;
    const k = KIND[sessionKind(s)];
    return (
      <Link to={`/app/sessions/${encodeURIComponent(s.id)}`} className="block min-w-0 rounded-xl border border-line bg-slate-1 p-3 hover:border-line-2 sm:p-4" style={{ borderTopColor: tone, borderTopWidth: 3 }}>
        <div className="flex items-center gap-2"><StateShape kind={sessionKind(s)} size={11} /><span className="min-w-0 truncate text-[14px] font-semibold text-snow sm:text-[16px]">{sessionLabel(s)}</span></div>
        <div className="mt-1 break-words text-[12.5px] text-fog">{s.ownerName ?? "—"} · {modelShort(s.model)} · {fmtDate(s.startedAt)}</div>
        <div className="mt-1 break-words text-[12.5px]" style={{ color: k.color }}>{k.label}{s.endReason ? ` · ${s.endReason}` : ""}{s.git?.branch ? <span className="text-fog"> · {s.git.branch}</span> : null}</div>
      </Link>
    );
  };

  return (
    <div className="mx-auto max-w-5xl p-3 sm:p-5">
      <Link to={`/app/sessions/${encodeURIComponent(a)}`} className="inline-flex items-center gap-1.5 text-[13px] text-fog hover:text-snow"><ArrowLeft size={14} /> Back to the session</Link>
      <div className="mt-3 flex items-end justify-between gap-3">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">Compare sessions</h1>
        {b ? <button onClick={() => setParams({ a: b, b: a })} className="inline-flex items-center gap-1.5 text-[13px] text-fog hover:text-snow"><ArrowLeftRight size={14} /> Swap</button> : null}
      </div>
      <div className="mt-4 grid grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-5">
        <div />
        {head(da, "var(--color-teal-400)", "a")}
        <div>
          {head(db, "var(--color-violet-400)", "b")}
          {b ? <button onClick={() => setParams({ a })} className="mt-1.5 text-[12px] text-fog hover:text-snow">Choose another</button> : null}
        </div>
      </div>

      {!b ? (
        <Panel title="Compare with…" className="mt-4"><Picker exclude={a} onPick={(id) => setParams({ a, b: id })} /></Panel>
      ) : fa && fb ? (
        <>
          <Panel className="mt-4">
            <Row label="Est. cost" a={fa.cost} b={fb.cost} fmt={(n) => fmtUsd(n)} />
            <Row label="Cost per hour" a={fa.costPerHour} b={fb.costPerHour} fmt={(n) => fmtUsd(n)} />
            <Row label="Ran for" a={fa.ms} b={fb.ms} fmt={fmtDuration} />
            <Row label="Tokens" a={fa.tokens} b={fb.tokens} fmt={fmtTokens} />
            <Row label="Cache reads" a={Math.round(fa.cacheShare * 100)} b={Math.round(fb.cacheShare * 100)} fmt={(n) => `${n}%`} lowerIsBetter={false} />
            <Row label="Agents" a={fa.agents} b={fb.agents} fmt={String} />
            <Row label="Failed agents" a={fa.failed} b={fb.failed} fmt={String} />
            <Row label="Tool calls" a={fa.toolCalls} b={fb.toolCalls} fmt={String} />
            <Row label="Context blowouts" a={fa.blowouts} b={fb.blowouts} fmt={String} />
            <Row label="Asked a person" a={fa.asks} b={fb.asks} fmt={(n) => `${n} time${n === 1 ? "" : "s"}`} />
            <Row label="Mean wait for an answer" a={fa.meanWait} b={fb.meanWait} fmt={fmtDuration} />
            <Row label="Files changed" a={fa.files} b={fb.files} fmt={String} lowerIsBetter={false} />
            <Row label="Lines changed" a={fa.lines} b={fb.lines} fmt={(n) => n.toLocaleString()} lowerIsBetter={false} />
          </Panel>
          {toolNames.length ? (
            <Panel title="Tool calls by tool" className="mt-4">
              {toolNames.slice(0, 15).map((t) => <Row key={t} label={t} a={fa.tools[t] ?? 0} b={fb.tools[t] ?? 0} fmt={String} />)}
            </Panel>
          ) : null}
          <p className="mt-3 text-[12px] text-fog">A ratio chip marks the larger value when the two differ by more than 15%; red where more usually means worse.</p>
        </>
      ) : (
        <div className="flex h-48 items-center justify-center"><Spinner /></div>
      )}
    </div>
  );
}
