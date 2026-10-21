import type { Action, AgentView, AskDetail, RiskFlag } from "@tessera/contract";
import { AlertTriangle, Check, ChevronDown, Loader2, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ago, fmtTime } from "../lib/format";
import { CallDetail } from "./CallDetail";
import { ExplainFailure } from "./ExplainFailure";

/** A flag an approver should see before deciding, coloured by how much it matters. */
export function RiskChips({ flags, compact = false }: { flags: RiskFlag[]; compact?: boolean }) {
  if (!flags.length) return null;
  const tone: Record<RiskFlag["level"], string> = {
    high: "border-rose-600/50 bg-rose-600/15 text-rose-400",
    medium: "border-amber-400/40 bg-amber-400/10 text-amber-400",
    info: "border-line-2 bg-slate-2 text-mist",
  };
  const shown = compact ? flags.slice(0, 2) : flags;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((f) => (
        <span key={f.code} title={f.detail} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone[f.level]}`}>
          {f.level === "high" ? <ShieldAlert size={11} /> : f.level === "medium" ? <AlertTriangle size={11} /> : null}
          {f.label}
        </span>
      ))}
      {compact && flags.length > shown.length ? <span className="text-[11px] text-fog">+{flags.length - shown.length}</span> : null}
    </div>
  );
}

// ---- diff ------------------------------------------------------------------

type DiffLine = { kind: "same" | "del" | "add"; text: string };

/** Line diff by longest common subsequence; inputs are capped (6000 chars each) so this stays small. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === "") return b.map((text) => ({ kind: "add" as const, text }));
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export function Diff({ before, after, path }: { before: string; after: string; path?: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = lines.reduce((s, l) => ({ add: s.add + (l.kind === "add" ? 1 : 0), del: s.del + (l.kind === "del" ? 1 : 0) }), { add: 0, del: 0 });
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink">
      {path ? (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-mist">
          <span className="truncate">{path}</span>
          <span className="ml-auto shrink-0 text-teal-300">+{stats.add}</span>
          <span className="shrink-0 text-rose-400">−{stats.del}</span>
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto p-0 font-mono text-[12px] leading-[1.45]">
        {lines.map((l, i) => (
          <div key={i} className={`px-3 ${l.kind === "add" ? "bg-teal-700/25 text-teal-100" : l.kind === "del" ? "bg-rose-600/20 text-rose-200" : "text-fog"}`}>
            <span className="mr-2 inline-block w-3 select-none text-ash">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---- what is being asked ---------------------------------------------------

/** The substance of a permission request: the command, the change, the file, the URL, in full. */
export function AskSubstance({ detail, tool }: { detail: AskDetail; tool: string | null }) {
  return (
    <div className="space-y-2.5">
      {detail.command ? (
        <div>
          {detail.description ? <div className="mb-1 text-[12px] text-fog">{detail.description}</div> : null}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-ink p-3 font-mono text-[12.5px] leading-relaxed text-snow">{detail.command}</pre>
        </div>
      ) : null}
      {detail.edits.map((e, i) => (
        <Diff key={`${e.path}:${i}`} before={e.before} after={e.after} path={`${e.path}${e.replaceAll ? " · every occurrence" : ""}`} />
      ))}
      {detail.write ? (
        <div className="overflow-hidden rounded-lg border border-line bg-ink">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-mist">
            <span className="truncate">{detail.write.path}</span>
            <span className="ml-auto shrink-0 text-fog">{detail.write.lines} lines · {detail.write.bytes >= 1024 ? `${(detail.write.bytes / 1024).toFixed(1)} KB` : `${detail.write.bytes} B`}{detail.write.excerpt.length < detail.write.bytes ? " · first part shown" : ""}</span>
          </div>
          <pre className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-[1.45] text-mist">{detail.write.excerpt}</pre>
        </div>
      ) : null}
      {detail.url ? <div className="break-all rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[12.5px] text-snow">{tool ? <span className="text-fog">{tool} · </span> : null}{detail.url}</div> : null}
      {!detail.command && !detail.edits.length && !detail.write && !detail.url && detail.paths.length ? (
        <ul className="rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[12.5px] text-snow">{detail.paths.map((p) => <li key={p} className="break-all">{p}</li>)}</ul>
      ) : null}
    </div>
  );
}

// ---- recent actions --------------------------------------------------------

function StatusMark({ status }: { status: Action["status"] }) {
  if (status === "running") return <Loader2 size={12} className="animate-spin text-teal-400" />;
  if (status === "ok") return <Check size={12} className="text-teal-300" />;
  if (status === "denied") return <ShieldAlert size={12} className="text-amber-400" />;
  return <X size={12} className="text-rose-400" />;
}

/** How long a finished call took, or null while it runs or when the reporter did not say. */
function took(a: Action): string | null {
  if (a.durationMs == null) return null;
  return a.durationMs >= 1000 ? `${(a.durationMs / 1000).toFixed(1)}s` : `${a.durationMs}ms`;
}

const RESULT: Record<Action["status"], string> = { running: "still running", ok: "succeeded", failed: "failed", denied: "denied by policy or a person" };

type ActionFilter = "all" | "failed" | "running";

/**
 * The last tool calls, newest first, so an approver sees what led to the prompt and a watcher sees what is happening.
 * A row opens to the whole call: tool, agent, when, how long, and the full summary and error.
 */
/**
 * `explainIn`: the session id, where failures can be explained by Claude (the organisation turned it on).
 * `sessionId`: open rows read everything kept about the call (command, output, patch) from the server.
 * `footer`: below the list, such as a way to load older calls.
 */
export function ActionList({ actions, agents = [], now, limit, title, filterable = false, explainIn, sessionId, footer }: { actions: Action[]; agents?: AgentView[]; now: number; limit?: number; title?: string; filterable?: boolean; explainIn?: string; sessionId?: string; footer?: ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<ActionFilter>("all");
  const newestFirst = useMemo(() => [...actions].reverse(), [actions]);
  const counts = useMemo(() => ({ all: actions.length, failed: actions.filter((a) => a.status === "failed" || a.status === "denied").length, running: actions.filter((a) => a.status === "running").length }), [actions]);
  const matching = filter === "all" ? newestFirst : filter === "failed" ? newestFirst.filter((a) => a.status === "failed" || a.status === "denied") : newestFirst.filter((a) => a.status === "running");
  const list = all || !limit ? matching : matching.slice(0, limit);
  const agentName = (id: string | null) => {
    const a = id ? agents.find((x) => x.id === id) : undefined;
    return a ? (a.kind === "orchestrator" ? "orchestrator" : (a.type ?? a.kind)) : null;
  };
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (!actions.length) return <p className="text-[12.5px] text-fog">No tool calls reported yet.</p>;
  const chip = (f: ActionFilter, label: string) => (
    <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`rounded-md px-2 py-0.5 ${filter === f ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>
      {label} <span className="text-ash">{counts[f]}</span>
    </button>
  );
  return (
    <div>
      {title || (filterable && (counts.failed || counts.running)) ? (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          {title ? <div className="text-[12px] font-medium text-mist">{title}</div> : <span />}
          {filterable && (counts.failed || counts.running) ? (
            <div className="flex items-center gap-0.5 text-[11.5px]">
              {chip("all", "All")}
              {counts.failed ? chip("failed", "Failed") : null}
              {counts.running ? chip("running", "Running") : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {list.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-ink">
          {list.map((a) => {
            const isOpen = open.has(a.id);
            const agent = agentName(a.agentId);
            const when = a.status === "running" ? `${ago(a.ts, now)} ago` : (took(a) ?? ago(a.ts, now));
            return (
              <li key={a.id}>
                <button type="button" onClick={() => toggle(a.id)} aria-expanded={isOpen} aria-controls={`action-${a.id}`} className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-1 focus:outline-none focus-visible:bg-slate-1">
                  <span className="mt-0.5 shrink-0"><StatusMark status={a.status} /></span>
                  <span className="min-w-0 flex-1">
                    <span className={`block font-mono text-mist ${isOpen ? "whitespace-pre-wrap break-words" : "truncate"}`}>{a.summary}{a.withheld ? <span className="ml-1.5 font-sans text-[11px] text-amber-400">text withheld by a network filter</span> : null}</span>
                    {a.error && !isOpen ? <span className="block truncate text-rose-400">{a.error}</span> : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-fog">{when}</span>
                  <ChevronDown size={12} className={`mt-0.5 shrink-0 text-ash transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
                {isOpen ? (
                  <dl id={`action-${a.id}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-line bg-slate-1 px-2.5 py-2 pl-8 text-[11.5px] text-mist">
                    <dt className="text-ash">Tool</dt>
                    <dd className="font-mono">{a.tool}</dd>
                    {agent ? (
                      <>
                        <dt className="text-ash">Agent</dt>
                        <dd>{agent}</dd>
                      </>
                    ) : null}
                    <dt className="text-ash">Started</dt>
                    <dd>{fmtTime(a.ts)} · {ago(a.ts, now)}</dd>
                    <dt className="text-ash">Took</dt>
                    <dd>{a.status === "running" ? "still running" : (took(a) ?? "not reported")}</dd>
                    <dt className="text-ash">Result</dt>
                    <dd>{RESULT[a.status]}</dd>
                    {a.error ? (
                      <>
                        <dt className="text-ash">Error</dt>
                        <dd className="whitespace-pre-wrap break-words font-mono text-rose-400">{a.error}</dd>
                      </>
                    ) : null}
                    {sessionId ? <CallDetail sessionId={sessionId} action={a} /> : null}
                    {explainIn && a.status === "failed" ? <dd className="col-span-2"><ExplainFailure sessionId={explainIn} target={{ kind: "action", id: a.id }} /></dd> : null}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-fog">No {filter} tool calls.</p>
      )}
      {footer}
      {limit && matching.length > limit ? (
        <button type="button" onClick={() => setAll(!all)} className="mt-1.5 text-[12px] text-fog hover:text-snow">
          {all ? "Show fewer" : `Show all ${matching.length}`}
        </button>
      ) : null}
    </div>
  );
}

// ---- allow with a choice of scope -----------------------------------------

/** "Allow once" with a drop-down that also offers allowing a pattern for the rest of the session. */
export function AllowMenu({ ruleLabel, loading, onAllow }: { ruleLabel: string | null; loading: boolean; onAllow: (scope: "once" | "session") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const base = "inline-flex h-8 items-center justify-center font-medium text-[13px] text-ink transition-colors";
  return (
    <div ref={ref} className="relative inline-flex">
      <button type="button" disabled={loading} onClick={() => onAllow("once")} className={`${base} gap-2 rounded-l-lg bg-teal-400 px-3 hover:bg-teal-300 disabled:opacity-50 ${ruleLabel ? "" : "rounded-r-lg"}`}>
        {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
        Allow once
      </button>
      {ruleLabel ? (
        <>
          <button type="button" aria-label="More ways to allow" aria-expanded={open} disabled={loading} onClick={() => setOpen((o) => !o)} className={`${base} rounded-r-lg border-l border-ink/30 bg-teal-400 px-1.5 hover:bg-teal-300 disabled:opacity-50`}>
            <ChevronDown size={14} />
          </button>
          {open ? (
            <div className="absolute left-0 top-9 z-20 w-72 overflow-hidden rounded-lg border border-line-2 bg-slate-1 shadow-2xl">
              <button type="button" onClick={() => { setOpen(false); onAllow("session"); }} className="block w-full px-3 py-2.5 text-left hover:bg-slate-2">
                <div className="text-[13px] font-medium text-snow">Allow for the rest of this session</div>
                <div className="mt-0.5 font-mono text-[11.5px] text-fog">{ruleLabel}</div>
                <div className="mt-1 text-[11.5px] text-fog">The agent stops asking about this pattern until the session ends. Nothing is written to settings files.</div>
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
