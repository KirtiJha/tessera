import type { SessionView } from "@tessera/contract";
import { AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { KIND, SessionCard, StateShape } from "../../components/SessionCard";
import { Sparkline } from "../../components/Sparkline";
import { Empty } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { sessionKind, sessionLabel, useFleet, useSessions, type SessionKind } from "../../lib/fleet";
import { ago, fmtTokens, fmtUsd } from "../../lib/format";

const ORDER: SessionKind[] = ["waiting", "running", "background", "stale", "done"];

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Kpi({ label, value, sub, series, color }: { label: string; value: string; sub?: string; series?: number[]; color?: string }) {
  return (
    <div className="rounded-xl border border-line bg-slate-1 px-4 py-3">
      <div className="text-[12px] text-fog">{label}</div>
      <div className="mt-0.5 flex items-end justify-between gap-3">
        <div>
          <div className="font-display text-[26px] font-semibold leading-none tracking-tight text-snow">{value}</div>
          {sub ? <div className="mt-1 text-[11.5px] text-fog">{sub}</div> : null}
        </div>
        {series ? <div className="w-28 self-end"><Sparkline values={series} color={color} height={30} /></div> : null}
      </div>
    </div>
  );
}

export function Wall() {
  const { kpis, events, touched, connected } = useFleet();
  const sessions = useSessions();
  const { me } = useAuth();
  const now = useNow();
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<SessionKind | "all" | "mine">("all");
  const [group, setGroup] = useState<"state" | "person">("state");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions
      .filter((s) => (only === "all" ? true : only === "mine" ? s.ownerId === me?.user.id : sessionKind(s) === only))
      .filter((s) => !needle || [sessionLabel(s), s.ownerName, s.git?.branch, s.cwd, s.model, s.machine?.hostname].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => ORDER.indexOf(sessionKind(a)) - ORDER.indexOf(sessionKind(b)) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [sessions, q, only, me]);

  const groups = useMemo(() => {
    const m = new Map<string, SessionView[]>();
    for (const s of filtered) {
      const key = group === "state" ? sessionKind(s) : (s.ownerName ?? "Unassigned");
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => (group === "state" ? ORDER.indexOf(a[0] as SessionKind) - ORDER.indexOf(b[0] as SessionKind) : a[0].localeCompare(b[0])));
  }, [filtered, group]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sessions.length, mine: sessions.filter((s) => s.ownerId === me?.user.id).length };
    for (const k of ORDER) c[k] = sessions.filter((s) => sessionKind(s) === k).length;
    return c;
  }, [sessions, me]);

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 p-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Live sessions" value={String(kpis?.liveSessions ?? sessions.length)} sub={kpis ? `${kpis.runningAgents} agents working` : undefined} />
          <Kpi label="Waiting on someone" value={String(kpis?.waitingSessions ?? 0)} sub={kpis?.blowoutsToday ? `${kpis.blowoutsToday} context blowouts today` : "no blowouts today"} />
          <Kpi label="Tokens per minute" value={kpis ? fmtTokens(kpis.tokensPerMinute.at(-1) ?? 0) : "—"} series={kpis?.tokensPerMinute} />
          <Kpi label="Estimated cost today" value={kpis ? fmtUsd(kpis.costTodayUsd) : "—"} sub={kpis?.unpricedSessions ? `${kpis.unpricedSessions} session${kpis.unpricedSessions > 1 ? "s" : ""} with unpriced models` : "from tokens × your prices"} series={kpis?.costPerMinuteUsd} color="var(--color-amber-400)" />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-slate-1 p-1">
            {(["all", "mine", ...ORDER] as const).map((k) => (
              <button key={k} onClick={() => setOnly(k)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] ${only === k ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>
                {k !== "all" && k !== "mine" ? <StateShape kind={k} size={10} /> : null}
                {k === "all" ? "All" : k === "mine" ? "Mine" : KIND[k].label}
                <span className="text-[11px] text-ash">{counts[k] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-line bg-slate-1 p-1 text-[12.5px]">
            <button onClick={() => setGroup("state")} className={`rounded-md px-2.5 py-1 ${group === "state" ? "bg-slate-3 text-snow" : "text-fog"}`}>By state</button>
            <button onClick={() => setGroup("person")} className={`rounded-md px-2.5 py-1 ${group === "person" ? "bg-slate-3 text-snow" : "text-fog"}`}>By person</button>
          </div>
          <label className="relative ml-auto">
            <Search size={14} className="absolute left-2.5 top-2.5 text-fog" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, branch, person, model…" className="h-9 w-72 rounded-lg border border-line bg-slate-1 pl-8 pr-3 text-[13px] text-snow placeholder:text-ash focus:border-teal-400 focus:outline-none" />
          </label>
        </div>

        {sessions.length === 0 ? (
          <div className="mt-6">
            <Empty
              title={connected ? "Nothing is reporting yet" : "Connecting to the fleet"}
              body={connected ? "Enrol a machine and install the reporter hooks. The next Claude Code session you start will appear here within two seconds of its first prompt." : "Waiting for the live stream."}
              action={connected ? <Link to="/app/devices" className="inline-flex h-10 items-center rounded-lg bg-teal-400 px-4 text-[14px] font-medium text-ink hover:bg-teal-300">Enrol a machine</Link> : undefined}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-6"><Empty title="No sessions match" body="Try another filter or clear the search." /></div>
        ) : (
          groups.map(([key, list]) => (
            <section key={key} className="mt-6">
              <h2 className="mb-3 flex items-center gap-2 text-[12.5px] font-medium text-fog">
                {group === "state" ? <><StateShape kind={key as SessionKind} size={10} /> {KIND[key as SessionKind].label}</> : key}
                <span className="text-ash">{list.length}</span>
              </h2>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" }}>
                <AnimatePresence>
                  {list.map((s) => (
                    <SessionCard key={s.id} s={s} now={now} flash={touched.has(s.id)} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))
        )}
      </div>

      <aside className="pane hidden w-[300px] shrink-0 overflow-y-auto border-l border-line bg-ink-2 xl:block">
        <div className="sticky top-0 border-b border-line bg-ink-2 px-4 py-3 text-[12.5px] font-medium text-fog">Activity</div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-[12.5px] text-ash">Events from every session show here as they happen.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.slice(0, 80).map((e) => {
              const s = sessions.find((x) => x.id === e.sessionId);
              const tone = e.kind === "agent.fail" || e.kind === "tool.fail" || e.kind === "context.blowout" ? "text-rose-400" : e.kind === "wait" ? "text-amber-400" : e.kind === "answer" ? "text-teal-300" : "text-mist";
              return (
                <li key={`${e.sessionId}:${e.id}`} className="px-4 py-2.5">
                  <Link to={`/app/sessions/${encodeURIComponent(e.sessionId)}`} className="block">
                    <div className="flex items-center justify-between text-[11px] text-fog">
                      <span className="truncate">{s ? sessionLabel(s) : e.sessionId.slice(0, 8)}</span>
                      <span>{ago(e.ts, now)}</span>
                    </div>
                    <div className={`mt-0.5 text-[12.5px] leading-snug ${tone}`}>{e.text}</div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}
