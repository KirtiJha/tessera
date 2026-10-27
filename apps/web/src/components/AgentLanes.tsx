import type { Action, AgentView } from "@tessera/contract";
import { ChevronDown, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { agentLanes, type Lane } from "../lib/agents";
import { api, ApiError } from "../lib/api";
import { ago, fmtDuration } from "../lib/format";
import { ActionList } from "./Approval";

interface Page { total: number; actions: Action[]; more: boolean }

const STATUS: Record<AgentView["status"], { label: string; cls: string }> = {
  running: { label: "working", cls: "text-teal-300" },
  done: { label: "done", cls: "text-fog" },
  failed: { label: "failed", cls: "text-rose-400" },
  aborted: { label: "stopped", cls: "text-amber-400" },
};

/**
 * The session's tool calls one lane per agent, so parallel agents read apart:
 * each says what it is doing now, and opens to its own calls, with its whole
 * history from the server on request.
 */
export function AgentLanes({ sessionId, actions, agents, now, explainIn }: { sessionId: string; actions: Action[]; agents: AgentView[]; now: number; explainIn?: string }) {
  const lanes = useMemo(() => agentLanes(agents, actions), [agents, actions]);
  // Lanes start open while they work; a person's choice then sticks.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const isOpen = (l: Lane) => opened[l.key] ?? (l.agent ? l.agent.status === "running" : l.running.length > 0 || lanes.length === 1);
  return (
    <div className="space-y-2">
      {lanes.map((l) => (
        <LaneCard key={l.key} lane={l} open={isOpen(l)} onToggle={() => setOpened((o) => ({ ...o, [l.key]: !isOpen(l) }))} sessionId={sessionId} agents={agents} now={now} explainIn={explainIn} />
      ))}
    </div>
  );
}

function LaneCard({ lane: l, open, onToggle, sessionId, agents, now, explainIn }: { lane: Lane; open: boolean; onToggle: () => void; sessionId: string; agents: AgentView[]; now: number; explainIn?: string }) {
  const [older, setOlder] = useState<Action[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const a = l.agent;
  const status = a ? STATUS[a.status] : l.running.length ? STATUS.running : null;
  const total = a ? Object.values(a.toolCalls).reduce((n, c) => n + c, 0) : null;
  const elapsed = a ? (a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt) : null;
  const now1 = l.running.at(-1);
  const color = l.color ?? "var(--color-line-2)";

  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const before = older?.length ? older[older.length - 1]!.ts : undefined;
      const r = await api.get<Page>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/actions?limit=100&agent=${encodeURIComponent(l.key)}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setOlder((cur) => [...(cur ?? []), ...r.actions]);
      setMore(r.more);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load this agent's calls.");
    } finally {
      setBusy(false);
    }
  };
  const liveIds = new Set(l.calls.map((c) => c.id));
  const calls = older ? [...older.filter((c) => !liveIds.has(c.id)), ...l.calls].sort((x, y) => x.ts.localeCompare(y.ts)) : l.calls;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-ink-2" style={{ borderLeft: `3px solid ${color}` }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-1 focus:outline-none focus-visible:bg-slate-1">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-medium" style={{ color: l.color ?? "var(--color-snow)" }}>{l.label}</span>
            {status ? <span className={`text-[11.5px] ${status.cls}`}>{status.label}</span> : null}
            {l.parent ? <span className="text-[11.5px] text-ash">started by {l.parent}</span> : null}
            <span className="ml-auto text-[11.5px] text-fog">
              {total != null ? `${total} call${total === 1 ? "" : "s"}` : `${l.calls.length} recent call${l.calls.length === 1 ? "" : "s"}`}
              {elapsed != null ? ` · ${fmtDuration(Math.max(0, elapsed))}` : ""}
            </span>
          </span>
          {a?.description ? <span className="mt-0.5 block truncate text-[12.5px] text-mist">{a.description}</span> : null}
          <span className="mt-1 flex items-center gap-1.5 text-[12px]">
            {now1 ? (
              <>
                <Loader2 size={12} className="shrink-0 animate-spin text-teal-400" />
                <span className="min-w-0 truncate font-mono text-snow">{now1.summary}</span>
                <span className="shrink-0 text-[11px] text-fog">for {ago(now1.ts, now)}</span>
                {l.running.length > 1 ? <span className="shrink-0 text-[11px] text-fog">+{l.running.length - 1} more</span> : null}
              </>
            ) : a?.failure ? (
              <span className="min-w-0 truncate text-rose-400">{a.failure.summary}</span>
            ) : l.last ? (
              <>
                <span className="shrink-0 text-ash">last</span>
                <span className="min-w-0 truncate font-mono text-fog">{l.last.summary}</span>
                <span className="shrink-0 text-[11px] text-fog">{ago(l.last.endedAt ?? l.last.ts, now)} ago</span>
              </>
            ) : (
              <span className="text-fog">{a?.status === "running" ? "Thinking; no tool call yet." : "No recent tool calls."}</span>
            )}
          </span>
        </span>
        <ChevronDown size={13} className={`mt-1 shrink-0 text-ash transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-t border-line px-3 py-2">
          {calls.length ? <ActionList actions={calls} agents={agents} now={now} limit={older ? undefined : 6} explainIn={explainIn} sessionId={sessionId} /> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] text-fog">
            {older === null ? (
              <button type="button" onClick={() => void load()} disabled={busy} className="hover:text-snow disabled:opacity-60">{busy ? "Loading…" : l.agent ? "Show all of this agent's calls" : "Show all of the session's own calls"}</button>
            ) : more ? (
              <button type="button" onClick={() => void load()} disabled={busy} className="hover:text-snow disabled:opacity-60">{busy ? "Loading…" : "Load older"}</button>
            ) : (
              <span>{calls.length} call{calls.length === 1 ? "" : "s"}, all shown</span>
            )}
            {err ? <span className="text-rose-400">{err}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
