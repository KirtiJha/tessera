import type { Action, AgentView } from "@tessera/contract";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { ActionList } from "./Approval";

interface Page { total: number; actions: Action[]; more: boolean }

/**
 * A session's tool calls: the last ones live from its reports, and on request
 * the whole history from the server, a hundred at a time, oldest last. Live
 * rows win over stored ones, since they carry the latest state.
 */
export function ActionHistory({ sessionId, live, agents, now, explainIn }: { sessionId: string; live: Action[]; agents: AgentView[]; now: number; explainIn?: string }) {
  const [older, setOlder] = useState<Action[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  return <ActionList actions={all} agents={agents} now={now} limit={older ? undefined : 12} filterable explainIn={explainIn} sessionId={sessionId} footer={footer} />;
}
