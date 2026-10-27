import type { Action, AgentView } from "@tessera/contract";
import { useState } from "react";
import { useAgentFocus } from "../lib/agentFocus";
import { api, ApiError } from "../lib/api";
import { AgentLanes } from "./AgentLanes";
import { ActionList } from "./Approval";

interface Page { total: number; actions: Action[]; more: boolean }

/**
 * A session's tool calls: the last ones live from its reports, and on request
 * the whole history from the server, a hundred at a time, oldest last. Live
 * rows win over stored ones, since they carry the latest state. With agents in
 * the session they read either together, each row tagged with its agent, or
 * one lane per agent; a session with agents working opens on the lanes.
 */
export function ActionHistory({ sessionId, live, agents, now, explainIn }: { sessionId: string; live: Action[]; agents: AgentView[]; now: number; explainIn?: string }) {
  const [older, setOlder] = useState<Action[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { focus } = useAgentFocus();
  const hasAgents = agents.some((a) => a.kind !== "orchestrator");
  const [byAgent, setByAgent] = useState(() => agents.some((a) => a.kind !== "orchestrator" && a.status === "running"));

  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const before = older?.length ? older[older.length - 1]!.ts : undefined;
      const r = await api.get<Page>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/actions?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setOlder((cur) => [...(cur ?? []), ...r.actions]);
      setTotal(r.total);
      setMore(r.more);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load the history.");
    } finally {
      setBusy(false);
    }
  };

  const liveIds = new Set(live.map((a) => a.id));
  // ActionList shows newest first from an oldest-first list.
  const all = older ? [...[...older].reverse().filter((a) => !liveIds.has(a.id)), ...live].sort((a, b) => a.ts.localeCompare(b.ts)) : live;
  const footer = (
    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] text-fog">
      {older === null ? (
        <button type="button" onClick={() => void load()} disabled={busy} className="hover:text-snow disabled:opacity-60">{busy ? "Loading…" : "Show the whole session's tool calls"}</button>
      ) : (
        <>
          <span>{all.length} of {Math.max(total ?? 0, all.length)} tool calls</span>
          {more ? <button type="button" onClick={() => void load()} disabled={busy} className="hover:text-snow disabled:opacity-60">{busy ? "Loading…" : "Load older"}</button> : null}
        </>
      )}
      {err ? <span className="text-rose-400">{err}</span> : null}
    </div>
  );
  const tab = (on: boolean, label: string) => (
    <button type="button" role="tab" aria-selected={byAgent === on} onClick={() => setByAgent(on)} className={`rounded-md px-2 py-0.5 ${byAgent === on ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>{label}</button>
  );
  // Focused on one agent, the page shows just its lane.
  if (focus) return <AgentLanes key={focus} sessionId={sessionId} actions={all} agents={agents} now={now} explainIn={explainIn} only={focus} />;
  if (!hasAgents) return <ActionList actions={all} agents={agents} now={now} limit={older ? undefined : 12} filterable explainIn={explainIn} sessionId={sessionId} footer={footer} />;
  return (
    <div>
      <div className="mb-2 flex items-center gap-0.5 text-[11.5px]" role="tablist" aria-label="Group tool calls">
        {tab(true, "By agent")}
        {tab(false, "All together")}
      </div>
      {byAgent ? (
        <AgentLanes sessionId={sessionId} actions={all} agents={agents} now={now} explainIn={explainIn} />
      ) : (
        <ActionList actions={all} agents={agents} now={now} limit={older ? undefined : 12} filterable explainIn={explainIn} sessionId={sessionId} footer={footer} showAgent />
      )}
    </div>
  );
}
