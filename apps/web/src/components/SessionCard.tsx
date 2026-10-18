import type { SessionView } from "@tessera/contract";
import { memo } from "react";
import { Link } from "react-router-dom";
import { sessionKind, sessionLabel, type SessionKind } from "../lib/fleet";
import { ago, fmtDuration, fmtTokens, fmtUsd, modelShort } from "../lib/format";

export const KIND: Record<SessionKind, { color: string; bg: string; label: string }> = {
  running: { color: "var(--color-teal-400)", bg: "rgba(45,212,191,0.10)", label: "Running" },
  waiting: { color: "var(--color-amber-400)", bg: "rgba(245,165,36,0.12)", label: "Waiting" },
  background: { color: "var(--color-violet-400)", bg: "rgba(167,139,250,0.10)", label: "Background work" },
  stale: { color: "var(--color-fog)", bg: "rgba(139,151,166,0.10)", label: "Silent" },
  done: { color: "var(--color-fog)", bg: "rgba(139,151,166,0.08)", label: "Ended" },
};

/** The state shape: a square for running, a diamond for waiting, a ring for background, a dash for silent, a check for done. */
export function StateShape({ kind, size = 12 }: { kind: SessionKind; size?: number }) {
  const c = KIND[kind].color;
  const s = size;
  switch (kind) {
    case "waiting":
      return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0.5 11.5 6 6 11.5 0.5 6z" fill={c} /></svg>;
    case "background":
      return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2.2" /></svg>;
    case "stale":
      return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="4.6" width="10" height="2.8" rx="1.4" fill={c} /></svg>;
    case "done":
      return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 4.8 9.3 10 3.7" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    default:
      return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2.5" fill={c} /></svg>;
  }
}

export function ContextBar({ used, window: w, blowouts }: { used: number; window: number; blowouts: number }) {
  const pct = Math.min(100, Math.round((used / w) * 100));
  const color = pct >= 90 ? "var(--color-rose-400)" : pct >= 75 ? "var(--color-amber-400)" : "var(--color-teal-400)";
  return (
    <div className="flex items-center gap-2" title={`${fmtTokens(used)} of ${fmtTokens(w)} context`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-3">
        <div className="h-full rounded-full transition-[width,background-color] duration-500 ease-out" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-9 text-right text-[11.5px] text-fog">{pct}%</span>
      {blowouts > 0 ? <span className="rounded-sm bg-rose-600/30 px-1 text-[10.5px] font-semibold text-rose-400" title={`${blowouts} context blowout${blowouts > 1 ? "s" : ""}`}>×{blowouts}</span> : null}
    </div>
  );
}

export function AgentStrip({ s }: { s: SessionView }) {
  const agents = s.agents.filter((a) => a.kind !== "orchestrator");
  if (!agents.length) return <span className="text-[11.5px] text-ash">No agents launched</span>;
  return (
    <div className="flex flex-wrap items-center gap-1" title={`${agents.length} agent${agents.length > 1 ? "s" : ""}`}>
      {agents.slice(0, 24).map((a) => (
        <span
          key={a.id}
          className={`h-3 w-3 rounded-[3px] ${a.status === "running" ? "bg-teal-400" : a.status === "failed" ? "bg-rose-400" : a.status === "aborted" ? "bg-amber-500" : "bg-slate-3"}`}
          title={`${a.type ?? a.kind}: ${a.status}${a.description ? ` — ${a.description}` : ""}`}
        />
      ))}
      {agents.length > 24 ? <span className="text-[11px] text-fog">+{agents.length - 24}</span> : null}
    </div>
  );
}

/**
 * One session tile. Memoised: a card re-renders only when its session object,
 * the second it shows, or its new state changes. `isNew` animates the card in
 * once (CSS, no JavaScript per frame) when the session first appears; a card
 * scrolled into view on a virtualized wall appears without animation.
 */
export const SessionCard = memo(function SessionCard({ s, now, isNew }: { s: SessionView; now: number; isNew?: boolean }) {
  const kind = sessionKind(s);
  const k = KIND[kind];
  const plan = s.plan?.steps ?? [];
  const planDone = plan.filter((p) => p.status === "completed").length;
  const runningAgents = s.agents.filter((a) => a.status === "running" && a.kind !== "orchestrator").length;
  const failed = s.agents.filter((a) => a.status === "failed").length;
  const elapsed = (s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.startedAt);

  return (
    <div className={isNew ? "tile-enter" : undefined}>
      <Link
        to={`/app/sessions/${encodeURIComponent(s.id)}`}
        className={`relative block overflow-hidden rounded-xl border bg-slate-1 shadow-tile transition-colors hover:border-line-2 ${kind === "waiting" ? "breathe border-amber-400/50" : "border-line"}`}
        style={{ borderTopColor: k.color, borderTopWidth: 3 }}
      >
        <div className="px-4 pt-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-[5px]"><StateShape kind={kind} /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold leading-tight text-snow">{sessionLabel(s)}</div>
              <div className="mt-0.5 truncate text-[12px] text-fog">
                {s.ownerName ?? "Unassigned"}{s.assignee ? ` → ${s.assignee.name}` : ""}{s.machine ? ` · ${s.machine.hostname}` : ""}{s.git?.branch ? ` · ${s.git.branch}` : ""}
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-line-2 px-1.5 py-0.5 text-[11px] text-mist">{modelShort(s.model)}{s.effort ? ` · ${s.effort}` : ""}</span>
          </div>

          <div className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: k.color }}>
            <span className="font-medium">{kind === "waiting" ? (s.openAsk ? { question: "Has a question", plan: "Plan needs approval", permission: "Permission needed" }[s.openAsk.kind] : "Waiting for input") : kind === "stale" ? `Silent for ${ago(s.lastSeenAt, now)}` : kind === "done" ? `Ended${s.endReason ? ` · ${s.endReason}` : ""}` : kind === "background" ? "Idle on background work" : runningAgents ? `${runningAgents} agent${runningAgents > 1 ? "s" : ""} working` : "Working"}</span>
            {failed ? <span className="ml-auto text-rose-400">{failed} failed</span> : null}
          </div>
          {s.openAsk ? <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-mist">{s.openAsk.tool ? <span className="font-mono text-[11.5px]">{s.openAsk.tool} · </span> : null}{s.openAsk.prompt}</div> : null}
        </div>

        <div className="mt-3 space-y-2 px-4">
          {s.context ? <ContextBar used={s.context.used} window={s.context.window} blowouts={s.blowouts} /> : <div className="text-[11.5px] text-ash">Context not reported</div>}
          <div className="flex items-center justify-between">
            <AgentStrip s={s} />
            {plan.length ? <span className="text-[11.5px] text-fog">plan {planDone}/{plan.length}</span> : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 divide-x divide-line border-t border-line text-center" style={{ background: k.bg }}>
          <div className="py-2"><div className="text-[13px] font-semibold text-snow">{fmtUsd(s.costUsd)}</div><div className="text-[10.5px] text-fog">{s.unpricedModels.length ? "partly unpriced" : "est. cost"}</div></div>
          <div className="py-2"><div className="text-[13px] font-semibold text-snow">{fmtTokens(s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite)}</div><div className="text-[10.5px] text-fog">tokens</div></div>
          <div className="py-2"><div className="text-[13px] font-semibold text-snow">{fmtDuration(elapsed)}</div><div className="text-[10.5px] text-fog">elapsed</div></div>
        </div>
      </Link>
    </div>
  );
});
