import type { SessionView } from "@tessera/contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BulkBar } from "../../components/BulkBar";
import { KIND, SessionCard, StateShape } from "../../components/SessionCard";
import { Sparkline } from "../../components/Sparkline";
import { Empty, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useBudgetStatuses, type BudgetStatus } from "../../lib/attention";
import { useAuth } from "../../lib/auth";
import { usePref } from "../../lib/prefs";
import { sessionKind, sessionLabel, useFleet, useSessions, type SessionKind } from "../../lib/fleet";
import { ago, fmtTokens, fmtUsd } from "../../lib/format";
import { buildRows, CARD_GAP, columnsFor, estimateRow, moveFocus } from "../../lib/wallLayout";
import { typingInField } from "./Shell";

const ORDER: SessionKind[] = ["waiting", "running", "background", "stale", "done"];

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Kpi({ label, short, value, sub, subTone = "text-fog", series, color, bar }: { label: string; short: string; value: string; sub?: string; subTone?: string; series?: number[]; color?: string; bar?: { pct: number; tone: string } }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-slate-1 px-2.5 py-2 sm:px-4 sm:py-3">
      <div className="truncate text-[11px] text-fog sm:text-[12px]"><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></div>
      <div className="mt-0.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[18px] font-semibold sm:text-[26px] leading-none tracking-tight text-snow">{value}</div>
          {sub ? <div className={`mt-1 hidden truncate text-[11.5px] sm:block ${subTone}`}>{sub}</div> : null}
        </div>
        {series ? <div className="hidden w-28 self-end sm:block"><Sparkline values={series} color={color} height={30} /></div> : null}
      </div>
      {bar ? (
        <div className="mt-2 hidden h-1.5 overflow-hidden rounded-full bg-slate-3 sm:block" role="progressbar" aria-valuenow={Math.round(bar.pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`h-full rounded-full ${bar.tone}`} style={{ width: `${Math.min(100, bar.pct)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Today's spend against the organisation's daily budget, for the cost tile: the hard limit if there is one, else the soft. */
function dailyBudget(budgets: BudgetStatus[]): { limit: number; pct: number; level: BudgetStatus["level"]; enforce: boolean } | null {
  const b = budgets.find((x) => x.scopeType === "org" && x.window === "daily" && (x.hardUsd ?? x.softUsd) !== null);
  if (!b) return null;
  const limit = (b.hardUsd ?? b.softUsd)!;
  return { limit, pct: limit > 0 ? (b.spentUsd / limit) * 100 : 0, level: b.level, enforce: b.enforce };
}

/** Sessions that appeared after the first snapshot, with when they appeared, so only they animate in. */
function useFirstSeen(sessions: SessionView[]): Map<string, number> {
  const seen = useRef<Map<string, number> | null>(null);
  if (seen.current === null) {
    if (sessions.length === 0) return new Map();
    seen.current = new Map(sessions.map((s) => [s.id, 0]));
  }
  const now = Date.now();
  for (const s of sessions) if (!seen.current.has(s.id)) seen.current.set(s.id, now);
  return seen.current;
}

const post = (id: string, path: string, body?: unknown) => api.post(`/api/fleet/sessions/${encodeURIComponent(id)}/${path}`, body);

export function Wall() {
  const { kpis, events, connected, sessions: byId } = useFleet();
  const sessions = useSessions();
  const { me } = useAuth();
  const now = useNow();
  const nav = useNavigate();
  const toast = useToast();
  // ?q= seeds the search (the command palette sends a person's name here); typing takes over from there.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  useEffect(() => {
    if (params.has("q")) setQ(params.get("q") ?? "");
  }, [params]);
  const searchRef = useRef<HTMLInputElement>(null);
  // Remembered per browser; a stale or hand-edited value falls back to the default.
  const [onlyPref, setOnly] = usePref<SessionKind | "all" | "mine">("wall.only", "all");
  const only = onlyPref === "all" || onlyPref === "mine" || (ORDER as readonly string[]).includes(onlyPref) ? onlyPref : "all";
  const [groupPref, setGroup] = usePref<"state" | "person">("wall.group", "state");
  const group = groupPref === "person" ? "person" : "state";
  const firstSeen = useFirstSeen(sessions);
  const budget = dailyBudget(useBudgetStatuses());

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions
      .filter((s) => (only === "all" ? true : only === "mine" ? s.ownerId === me?.user.id : sessionKind(s) === only))
      .filter((s) => !needle || [sessionLabel(s), s.ownerName, s.git?.branch, s.cwd, s.model, s.machine?.hostname].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => ORDER.indexOf(sessionKind(a)) - ORDER.indexOf(sessionKind(b)) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
  }, [sessions, q, only, me]);

  const groups = useMemo(() => {
    const m = new Map<string, SessionView[]>();
    for (const s of filtered) {
      const key = group === "state" ? sessionKind(s) : (s.ownerName ?? "Unassigned");
      let list = m.get(key);
      if (!list) m.set(key, (list = []));
      list.push(s);
    }
    return [...m.entries()].sort((a, b) => (group === "state" ? ORDER.indexOf(a[0] as SessionKind) - ORDER.indexOf(b[0] as SessionKind) : a[0].localeCompare(b[0])));
  }, [filtered, group]);

  // Every live count on the page comes from this one pass over the session list,
  // so the tiles, filters and top bar can never disagree.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sessions.length, mine: 0, agents: 0, live: 0 };
    for (const k of ORDER) c[k] = 0;
    for (const s of sessions) {
      const kind = sessionKind(s);
      c[kind]!++;
      if (kind !== "done") c.live!++;
      if (s.ownerId === me?.user.id) c.mine!++;
      for (const a of s.agents) if (a.status === "running" && a.kind !== "orchestrator") c.agents!++;
    }
    return c;
  }, [sessions, me]);

  // ---- virtualized list ----------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      setCols(columnsFor(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => buildRows(groups, cols), [groups, cols]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateRow(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 3,
  });

  // ---- keyboard focus and selection ---------------------------------------
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // A card that left the wall (ended, filtered out) cannot stay focused or selected.
  useEffect(() => {
    const ids = new Set(filtered.map((s) => s.id));
    if (focusId && !ids.has(focusId)) setFocusId(null);
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered, focusId]);

  // Keep the focused card in view on the virtualized wall.
  useEffect(() => {
    if (!focusId) return;
    const i = rows.findIndex((r) => r.kind === "cards" && r.items.some((s) => s.id === focusId));
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, rows]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** `a` / `d` on a waiting card: the card already shows the command or diff and its risk, so this is an informed answer. */
  const answerFocused = useCallback(
    async (id: string, yes: boolean) => {
      const s = byId.get(id);
      const ask = s?.openAsk;
      if (!s || !ask) return toast("That session is not waiting on anything.", "info");
      if (ask.kind === "question") return toast("Open the session to answer its question.", "info");
      const decision = ask.kind === "plan" ? (yes ? "approve" : "reject") : yes ? "allow" : "deny";
      try {
        await post(id, "answer", { askId: ask.id, decision });
        toast(`${sessionLabel(s)}: ${ask.kind === "plan" ? (yes ? "plan approved" : "plan sent back") : yes ? "allowed once" : "denied"}.`);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Could not send that.", "error");
      }
    },
    [byId, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inField = typingInField(e.target);
      if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (inField) return;
      const move = (key: string) => setFocusId((cur) => moveFocus(rows, cur, key));
      switch (e.key) {
        case "ArrowRight":
        case "ArrowLeft":
        case "ArrowDown":
        case "ArrowUp":
        case "Home":
        case "End":
          e.preventDefault();
          move(e.key);
          break;
        case "j":
          move("ArrowRight");
          break;
        case "k":
          move("ArrowLeft");
          break;
        case "Enter":
          if (focusId) nav(`/app/sessions/${encodeURIComponent(focusId)}`);
          break;
        case "x":
          if (focusId) toggleSelect(focusId);
          break;
        case "a":
        case "d":
          if (focusId) void answerFocused(focusId, e.key === "a");
          break;
        case "Escape":
          if (selected.size) setSelected(new Set());
          else setFocusId(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, focusId, selected.size, nav, toggleSelect, answerFocused]);

  /** Try each selected session; the server says per session whether this person may. Failures stay selected. */
  const runBulk = async (verb: string, past: string, fn: (id: string) => Promise<unknown>) => {
    const ids = [...selected];
    setBusy(verb);
    const results = await Promise.allSettled(ids.map(fn));
    const failed = ids.filter((_, i) => results[i]!.status === "rejected");
    const reason = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    const ok = ids.length - failed.length;
    if (failed.length) toast(`${past} ${ok} of ${ids.length}. ${failed.length} refused: ${reason instanceof ApiError ? reason.message : "not allowed"}`, ok ? "info" : "error");
    else toast(`${past} ${ok} session${ok === 1 ? "" : "s"}.`);
    setSelected(new Set(failed));
    setBusy(null);
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-3 pt-3 sm:px-5 sm:pt-5">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4">
            <Kpi label="Live sessions" short="Live" value={String(counts.live ?? 0)} sub={`${counts.agents ?? 0} agents working${kpis?.failedAgentsToday ? ` · ${kpis.failedAgentsToday} failed today` : ""}`} subTone={kpis?.failedAgentsToday ? "text-rose-400" : "text-fog"} />
            <Kpi label="Waiting on someone" short="Waiting" value={String(counts.waiting ?? 0)} sub={kpis?.blowoutsToday ? `${kpis.blowoutsToday} context blowouts today` : "no blowouts today"} />
            <Kpi label="Tokens per minute" short="Tok/min" value={kpis ? fmtTokens(kpis.tokensPerMinute.at(-1) ?? 0) : "—"} series={kpis?.tokensPerMinute} />
            <Kpi
              label="Estimated cost today"
              short="Today"
              value={kpis ? fmtUsd(kpis.costTodayUsd) : "—"}
              sub={budget ? `${Math.round(budget.pct)}% of ${fmtUsd(budget.limit, Number.isInteger(budget.limit) ? 0 : 2)} daily limit${budget.level === "hard" ? (budget.enforce ? " · over, calls denied" : " · over") : budget.level === "soft" ? " · over soft" : ""}` : kpis?.unpricedSessions ? `${kpis.unpricedSessions} session${kpis.unpricedSessions > 1 ? "s" : ""} with unpriced models` : "from tokens × your prices"}
              subTone={budget?.level === "hard" ? "text-rose-400" : budget?.level === "soft" ? "text-amber-400" : "text-fog"}
              series={kpis?.costPerMinuteUsd}
              color="var(--color-amber-400)"
              bar={budget ? { pct: budget.pct, tone: budget.level === "hard" ? "bg-rose-400" : budget.level === "soft" || budget.pct >= 75 ? "bg-amber-400" : "bg-teal-400" } : undefined}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 pb-3 sm:mt-5 sm:pb-4">
            <div className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-line bg-slate-1 p-1">
              {(["all", "mine", ...ORDER] as const).map((k) => (
                <button key={k} onClick={() => setOnly(k)} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] ${only === k ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>
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
            <label className="relative w-full sm:ml-auto sm:w-auto">
              <Search size={14} className="absolute left-2.5 top-2.5 text-fog" />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.value ? setQ("") : e.currentTarget.blur())} placeholder="Filter by name, branch, person, model…" className="h-9 w-full rounded-lg sm:w-72 border border-line bg-slate-1 pl-8 pr-3 text-[13px] text-snow placeholder:text-ash focus:border-teal-400 focus:outline-none" />
            </label>
          </div>
        </div>

        <div ref={scrollRef} className={`pane min-h-0 flex-1 overflow-y-auto border-t border-line px-3 pt-3 sm:px-5 ${selected.size ? "pb-24" : "pb-5"}`}>
          {sessions.length === 0 ? (
            <Empty
              title={connected ? "Nothing is reporting yet" : "Connecting to the fleet"}
              body={connected ? "Enrol a machine and install the reporter hooks. The next Claude Code session you start will appear here within two seconds of its first prompt." : "Waiting for the live stream."}
              action={connected ? <Link to="/app/devices" className="inline-flex h-10 items-center rounded-lg bg-teal-400 px-4 text-[14px] font-medium text-ink hover:bg-teal-300">Enrol a machine</Link> : undefined}
            />
          ) : filtered.length === 0 ? (
            <Empty title="No sessions match" body="Try another filter or clear the search." />
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index]!;
                return (
                  <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                    {row.kind === "header" ? (
                      <h2 className="flex items-center gap-2 pb-3 pt-2 text-[12.5px] font-medium text-fog">
                        {group === "state" ? <><StateShape kind={row.group as SessionKind} size={10} /> {KIND[row.group as SessionKind].label}</> : row.group}
                        <span className="text-ash">{row.count}</span>
                      </h2>
                    ) : (
                      <div className="grid pb-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: CARD_GAP }}>
                        {row.items.map((s) => {
                          const first = firstSeen.get(s.id) ?? 0;
                          return <SessionCard key={s.id} s={s} now={now} isNew={first > 0 && now - first < 1500} focused={focusId === s.id} selected={selected.has(s.id)} selecting={selected.size > 0} onSelect={toggleSelect} onFocus={setFocusId} />;
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <aside className="pane hidden w-[300px] shrink-0 overflow-y-auto border-l border-line bg-ink-2 xl:block">
        <div className="sticky top-0 border-b border-line bg-ink-2 px-4 py-3 text-[12.5px] font-medium text-fog">Activity</div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-[12.5px] text-ash">Events from every session show here as they happen.</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.slice(0, 80).map((e) => {
              const s = byId.get(e.sessionId);
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

      <BulkBar
        count={selected.size}
        shown={filtered.length}
        busy={busy}
        onSelectAll={() => setSelected(new Set(filtered.map((s) => s.id)))}
        onClear={() => setSelected(new Set())}
        onPause={() => void runBulk("pause", "Paused", (id) => post(id, "pause", { paused: true }))}
        onResume={() => void runBulk("resume", "Resumed", (id) => post(id, "pause", { paused: false }))}
        onStop={(reason) => void runBulk("stop", "Stopped", (id) => post(id, "stop", reason ? { reason } : {}))}
        onMessage={(text) => void runBulk("message", "Messaged", (id) => post(id, "message", { text }))}
      />
    </div>
  );
}
