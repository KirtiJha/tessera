import type { AgentView, EventView, SessionView } from "@tessera/contract";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Hand, OctagonX, Pause, Play, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AgentStrip, ContextBar, KIND, StateShape } from "../../components/SessionCard";
import { Sparkline } from "../../components/Sparkline";
import { Replay } from "../../components/Replay";
import { Button, Modal, Panel, Select, Spinner, Textarea, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useMedia } from "../../lib/useMedia";
import { sessionKind, sessionLabel, useFleet } from "../../lib/fleet";
import { ago, fmtDate, fmtDuration, fmtTokens, fmtUsd, modelShort } from "../../lib/format";

interface Detail {
  session: SessionView;
  live: boolean;
  canAct: boolean;
  events: EventView[];
  series: { ts: string; tokens: number; cost: number | null }[];
  asks: { id: string; kind: string; tool: string | null; prompt: string; options: string[]; createdAt: string; closedAt: string | null; outcome: string | null; answer: Record<string, unknown> | null; answeredBy: string | null }[];
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 bg-slate-1 px-4 py-3">
      <div className="text-[11.5px] text-fog">{label}</div>
      <div className="mt-0.5 truncate text-[16px] font-semibold text-snow">{value}</div>
      {sub ? <div className="truncate text-[11px] text-fog" title={sub}>{sub}</div> : null}
    </div>
  );
}

function AgentTree({ agents, selected, onSelect }: { agents: AgentView[]; selected: string | null; onSelect: (id: string) => void }) {
  const byParent = useMemo(() => {
    const m = new Map<string | null, AgentView[]>();
    for (const a of agents) m.set(a.parentId, [...(m.get(a.parentId) ?? []), a]);
    return m;
  }, [agents]);
  const ids = new Set(agents.map((a) => a.id));
  const roots = agents.filter((a) => !a.parentId || !ids.has(a.parentId));
  const render = (a: AgentView, depth: number): React.ReactNode => (
    <div key={a.id}>
      <button onClick={() => onSelect(a.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-2 ${selected === a.id ? "bg-slate-2" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${a.status === "running" ? "bg-teal-400 dot-live" : a.status === "failed" ? "bg-rose-400" : a.status === "aborted" ? "bg-amber-500" : "bg-slate-3"}`} />
        <span className="truncate text-snow">{a.type ?? a.kind}</span>
        <span className="truncate text-fog">{a.description}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-fog">{modelShort(a.model)} · {fmtUsd(a.costUsd)}</span>
      </button>
      {(byParent.get(a.id) ?? []).map((c) => render(c, depth + 1))}
    </div>
  );
  return <div className="space-y-0.5">{roots.map((a) => render(a, 0))}</div>;
}

function AgentDetail({ a }: { a: AgentView }) {
  const tools = Object.entries(a.toolCalls).sort((x, y) => y[1] - x[1]);
  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-fog">
        <span>{a.kind}{a.type ? ` · ${a.type}` : ""}</span>
        <span>{modelShort(a.model)}{a.effort ? ` · ${a.effort}` : ""}</span>
        <span>{a.status}</span>
        <span>{fmtTokens(a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite)} tokens · {fmtUsd(a.costUsd, 4)}</span>
      </div>
      {a.description ? <p className="text-snow">{a.description}</p> : null}
      {a.failure ? (
        <div className="rounded-lg border border-rose-600/50 bg-[#2a1a1e] p-3">
          <div className="text-[12px] font-medium text-rose-400">Failed · {a.failure.class.replace("_", " ")}{a.failure.tool ? ` · ${a.failure.tool}` : ""}</div>
          <div className="mt-1 text-mist">{a.failure.summary}</div>
          {a.failure.outputTail.length ? <pre className="mt-2 max-h-40 overflow-auto rounded bg-ink p-2 font-mono text-[11.5px] text-fog">{a.failure.outputTail.join("\n")}</pre> : null}
        </div>
      ) : null}
      {tools.length ? <div className="flex flex-wrap gap-1.5">{tools.map(([t, n]) => <span key={t} className="rounded-md border border-line-2 px-1.5 py-0.5 text-[11.5px] text-mist">{t} <span className="text-fog">×{n}</span></span>)}</div> : null}
      {a.promptExcerpt ? <div><div className="text-[11.5px] text-fog">Task</div><p className="mt-0.5 text-mist">{a.promptExcerpt}</p></div> : null}
      {a.answerExcerpt ? <div><div className="text-[11.5px] text-fog">Answer</div><p className="mt-0.5 text-mist">{a.answerExcerpt}</p></div> : null}
    </div>
  );
}

function Respond({ s, canAct, onDone }: { s: SessionView; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const ask = s.openAsk;
  const kind = sessionKind(s);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const [handOpen, setHandOpen] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; team: string | null }[]>([]);
  const [handTo, setHandTo] = useState("");
  useEffect(() => {
    if (handOpen && !people.length) void api.get<{ people: typeof people }>("/api/fleet/people").then((r) => setPeople(r.people));
  }, [handOpen, people.length]);

  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      toast(done);
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not send that.", "error");
    } finally {
      setBusy(null);
    }
  };
  const answer = (decision: string, extra: Record<string, unknown> = {}) =>
    act(decision, () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/answer`, { askId: ask!.id, decision, ...extra }), decision === "deny" || decision === "reject" ? "Sent. The session will see it on its next check." : "Sent. The session will continue in a moment.");

  if (!canAct) return <p className="text-[13px] text-fog">Only this session's owner, someone it was handed to, an approver on their team, or an admin can act on it.</p>;
  if (kind === "done") return <p className="text-[13px] text-fog">This session has ended.</p>;

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait">
        {ask ? (
          <motion.div key={ask.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-amber-400"><StateShape kind="waiting" size={10} /> {{ question: "Question", plan: "Plan approval", permission: "Permission request" }[ask.kind]} · {ago(ask.createdAt)}</div>
            {ask.tool ? <div className="mt-1.5 font-mono text-[12.5px] text-snow">{ask.tool}</div> : null}
            <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-snow">{ask.prompt}</p>
            {ask.kind === "question" ? (
              <div className="mt-3 space-y-2">
                {ask.options.map((o) => (
                  <Button key={o} size="sm" className="mr-2" loading={busy === o} onClick={() => answer("answer", { option: o })}>{o}</Button>
                ))}
                <Textarea rows={2} placeholder="Or type an answer…" value={text} onChange={(e) => setText(e.target.value)} />
                <Button size="sm" variant="primary" disabled={!text.trim()} loading={busy === "answer"} onClick={() => answer("answer", { text })}>Send answer</Button>
              </div>
            ) : ask.kind === "plan" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" loading={busy === "approve"} onClick={() => answer("approve")}>Approve plan</Button>
                <Textarea rows={2} placeholder="Feedback for a rejection (optional)…" value={text} onChange={(e) => setText(e.target.value)} className="w-full" />
                <Button size="sm" variant="danger" loading={busy === "reject"} onClick={() => answer("reject", { text })}>Send back</Button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" loading={busy === "allow"} onClick={() => answer("allow")}>Allow once</Button>
                <Textarea rows={2} placeholder="Reason for denying (optional)…" value={text} onChange={(e) => setText(e.target.value)} className="w-full" />
                <Button size="sm" variant="danger" loading={busy === "deny"} onClick={() => answer("deny", { text })}>Deny</Button>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[13px] text-fog">Nothing is waiting for an answer right now.</motion.p>
        )}
      </AnimatePresence>

      <div>
        <div className="mb-1.5 text-[12px] font-medium text-mist">Send a message</div>
        <Textarea rows={3} placeholder="Delivered the next time the session pauses, as an instruction to continue with." value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!message.trim()} loading={busy === "message"} onClick={() => act("message", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/message`, { text: message }).then(() => setMessage("")), "Message queued for the session.")}><Send size={14} /> Send</Button>
          <Button size="sm" disabled={s.stopRequested || s.status !== "running"} title={s.status !== "running" ? "Stop applies while the session is working" : undefined} loading={busy === "stop"} onClick={() => setStopOpen(true)}><OctagonX size={14} /> {s.stopRequested ? "Stopping…" : "Stop"}</Button>
          <Button size="sm" onClick={() => setHandOpen(true)}><Hand size={14} /> {s.assignee ? "Reassign" : "Hand over"}</Button>
          {s.tags.paused ? (
            <Button size="sm" variant="amber" loading={busy === "resume"} onClick={() => act("resume", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/pause`, { paused: false }), "Resumed. New tool calls are allowed again.")}><Play size={14} /> Resume</Button>
          ) : (
            <Button size="sm" loading={busy === "pause"} onClick={() => act("pause", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/pause`, { paused: true, reason: "paused from the console" }), "Paused. New tool calls will be denied until you resume.")}><Pause size={14} /> Pause</Button>
          )}
        </div>
      </div>

      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Stop this session's turn">
        <p className="text-[13.5px] leading-relaxed text-mist">Claude's next tool call is refused and its turn ends, handing control back to {s.ownerName ?? "the engineer"} in their terminal. The session stays open; nothing is undone.</p>
        <Textarea className="mt-3" rows={2} maxLength={300} placeholder="Why (shown in their terminal, optional)" value={stopReason} onChange={(e) => setStopReason(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setStopOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === "stop"} onClick={() => { setStopOpen(false); void act("stop", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/stop`, { reason: stopReason.trim() || undefined }), "Stop sent. It applies at the next tool call."); setStopReason(""); }}>Stop at the next tool call</Button>
        </div>
      </Modal>

      <Modal open={handOpen} onClose={() => setHandOpen(false)} title="Hand this session over">
        <p className="text-[13.5px] leading-relaxed text-mist">The person you choose is told when it waits, in Slack and the other channels, and can answer, stop or pause it. {s.ownerName ?? "The owner"} keeps their rights too.</p>
        <Select className="mt-3" value={handTo || s.assignee?.id || ""} onChange={(e) => setHandTo(e.target.value)} aria-label="Hand over to">
          <option value="">Choose someone…</option>
          {people.filter((p) => p.id !== s.ownerId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.team ? ` · ${p.team}` : ""} ({p.role})</option>)}
        </Select>
        <div className="mt-4 flex justify-end gap-2">
          {s.assignee ? <Button className="mr-auto" onClick={() => { setHandOpen(false); void act("hand", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/assign`, { userId: null }), `Handed back to ${s.ownerName ?? "the owner"}.`); }}>Hand back to {s.ownerName ?? "the owner"}</Button> : null}
          <Button onClick={() => setHandOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!(handTo || s.assignee?.id) || (handTo || s.assignee?.id) === s.assignee?.id} onClick={() => { const to = people.find((p) => p.id === handTo); setHandOpen(false); void act("hand", () => api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/assign`, { userId: handTo }), `Handed to ${to?.name ?? "them"}.`); }}>Hand over</Button>
        </div>
      </Modal>
    </div>
  );
}

export function SessionPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { sessions } = useFleet();
  const liveView = sessions.get(id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "replay" ? "replay" : "overview";
  // On a phone, what needs an answer comes first; on a wide screen it sits beside the detail.
  const wide = useMedia("(min-width: 1024px)");

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<Detail>(`/api/fleet/sessions/${encodeURIComponent(id)}`));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load the session.");
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <div className="p-6 text-[14px] text-rose-400">{err}</div>;
  if (!detail) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;

  const s = liveView ?? detail.session;
  const kind = sessionKind(s);
  const k = KIND[kind];
  const now = Date.now();
  const elapsed = (s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.startedAt);
  const selectedAgent = s.agents.find((a) => a.id === agent) ?? null;
  const plan = s.plan?.steps ?? [];
  const tokSeries = detail.series.map((p) => p.tokens);

  const respond = (
    <Panel
      title="Respond"
      action={
        detail.live && detail.canAct ? (
          <button onClick={() => void api.post(`/api/fleet/sessions/${encodeURIComponent(s.id)}/drop`).then(() => { toast("Removed from the wall."); nav("/app"); })} className="inline-flex items-center gap-1 text-[12px] text-fog hover:text-rose-400" title="Remove from the live wall (the session itself keeps running)">
            <Trash2 size={13} /> Remove
          </button>
        ) : null
      }
    >
      <Respond s={s} canAct={detail.canAct && detail.live} onDone={load} />
    </Panel>
  );

  return (
    <div className="p-3 sm:p-5">
      <Link to="/app" className="inline-flex items-center gap-1.5 text-[13px] text-fog hover:text-snow"><ArrowLeft size={14} /> Live wall</Link>

      {/* On a phone, answering is the point: the prompt and its buttons come before everything else. */}
      {!wide && tab === "overview" ? <div className="mt-3">{respond}</div> : null}

      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-slate-1" style={{ borderTopColor: k.color, borderTopWidth: 3 }}>
        <div className="flex flex-wrap items-start gap-4 px-4 pt-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <StateShape kind={kind} size={14} />
              <h1 className="min-w-0 max-w-full truncate font-display text-[22px] sm:text-[26px] font-semibold tracking-tight text-snow">{sessionLabel(s)}</h1>
              {s.tags.paused ? <span className="rounded-md bg-amber-400/15 px-2 py-0.5 text-[11.5px] font-medium text-amber-400">paused</span> : null}
              {s.stopRequested ? <span className="rounded-md bg-rose-600/20 px-2 py-0.5 text-[11.5px] font-medium text-rose-400">stopping</span> : null}
              {s.assignee ? <span className="rounded-md bg-violet-400/15 px-2 py-0.5 text-[11.5px] font-medium text-violet-400">handed to {s.assignee.name}</span> : null}
            </div>
            <div className="mt-1 break-words text-[13px] text-fog">
              {s.ownerName ?? "Unassigned"}{s.machine ? ` · ${s.machine.hostname}` : ""}{s.cwd ? ` · ${s.cwd}` : ""}{s.git?.branch ? ` · ${s.git.branch}` : ""}{s.git?.worktree ? " (worktree)" : ""}
            </div>
            <div className="mt-2 text-[13px] font-medium" style={{ color: k.color }}>
              {k.label}{kind === "stale" ? ` · last report ${ago(s.lastSeenAt, now)}` : ""}{kind === "done" && s.endReason ? ` · ${s.endReason}` : ""}
            </div>
          </div>
          <div className="hidden w-56 sm:block">
            <div className="text-[11.5px] text-fog">Tokens per minute · last 2 h</div>
            <Sparkline values={tokSeries.length ? tokSeries : [0, 0]} height={44} />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Model" value={modelShort(s.model)} sub={s.effort ?? undefined} />
          <Stat label="Est. cost" value={fmtUsd(s.costUsd, 4)} sub={s.unpricedModels.length ? `unpriced: ${s.unpricedModels.join(", ")}` : s.agents.length ? `incl. ${s.agents.length} agents` : "orchestrator only"} />
          <Stat label="Tokens" value={fmtTokens(s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite)} sub={`${fmtTokens(s.tokens.cacheRead)} cache read`} />
          <Stat label="Context" value={s.context ? `${Math.round((s.context.used / s.context.window) * 100)}%` : "—"} sub={s.blowouts ? `${s.blowouts} blowouts` : "no blowouts"} />
          <Stat label="Elapsed" value={fmtDuration(elapsed)} sub={`started ${fmtDate(s.startedAt)}`} />
          <Stat label="Agents" value={String(s.agents.filter((a) => a.kind !== "orchestrator").length)} sub={`${s.agents.filter((a) => a.status === "failed").length} failed`} />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 border-b border-line" role="tablist">
        {(["overview", "replay"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "overview" ? {} : { tab: t }, { replace: true })} className={`relative px-3 py-2 text-[13.5px] font-medium ${tab === t ? "text-snow" : "text-fog hover:text-snow"}`}>
            {t === "overview" ? "Overview" : "Replay"}
            {tab === t ? <motion.span layoutId="session-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-teal-400" /> : null}
          </button>
        ))}
        <Link to={`/app/compare?a=${encodeURIComponent(s.id)}`} className="ml-auto hidden pb-1 text-[12.5px] sm:block text-fog hover:text-teal-300">Compare with another session →</Link>
      </div>

      {tab === "replay" ? (
        <div className="mt-4"><Panel><Replay sessionId={s.id} live={detail.live} /></Panel></div>
      ) : (
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-4">
                    <Panel title="Agents">
            {s.context ? <div className="mb-3"><ContextBar used={s.context.used} window={s.context.window} blowouts={s.blowouts} /></div> : null}
            {s.agents.length ? (
              <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
                <AgentTree agents={s.agents} selected={agent} onSelect={setAgent} />
                <div className="rounded-lg border border-line bg-ink-2 p-3">{selectedAgent ? <AgentDetail a={selectedAgent} /> : <p className="text-[13px] text-fog">Select an agent to see its tools, cost and any failure.</p>}</div>
              </div>
            ) : (
              <div className="flex items-center gap-3 text-[13px] text-fog"><AgentStrip s={s} /></div>
            )}
          </Panel>

          <Panel title={s.plan?.title ? `Plan · ${s.plan.title}` : "Plan"}>
            {plan.length ? (
              <ol className="space-y-1.5">
                {plan.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 text-[13.5px]">
                    <span className={`h-3 w-3 rounded-[3px] ${p.status === "completed" ? "bg-teal-400" : p.status === "in_progress" ? "border-2 border-teal-400" : p.status === "blocked" ? "bg-rose-400" : "border border-line-2"}`} />
                    <span className={p.status === "completed" ? "text-fog line-through" : "text-snow"}>{p.title}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-fog">No plan reported. The session has not used its task list.</p>
            )}
          </Panel>

          {s.filesChanged.length ? (
            <Panel title={`Files changed · ${s.filesChanged.length}`}>
              <ul className="max-h-64 space-y-1 overflow-auto font-mono text-[12px]">
                {s.filesChanged.map((f) => (
                  <li key={f.path} className="flex gap-3 text-mist">
                    <span className="w-16 shrink-0 text-fog">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                    <span className="ml-auto shrink-0 text-teal-300">+{f.added}</span>
                    <span className="shrink-0 text-rose-400">−{f.removed}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="min-w-0 space-y-4">
          {wide ? respond : null}

          <Panel title="Questions and answers">
            {detail.asks.length ? (
              <ul className="space-y-3">
                {detail.asks.map((a) => (
                  <li key={a.id} className="text-[13px]">
                    <div className="text-[11.5px] text-fog">{a.kind}{a.tool ? ` · ${a.tool}` : ""} · {fmtDate(a.createdAt)}</div>
                    <div className="mt-0.5 line-clamp-3 text-mist">{a.prompt}</div>
                    <div className="mt-0.5 text-[12px]">{a.closedAt ? <span className={a.outcome === "answered" ? "text-teal-300" : "text-fog"}>{a.outcome === "answered" ? `${String(a.answer?.decision ?? "answered")} by ${a.answeredBy ?? "someone"}` : "closed by the session"}</span> : <span className="text-amber-400">open</span>}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fog">No questions yet.</p>
            )}
          </Panel>

          <Panel title="Events">
            {detail.events.length ? (
              <ul className="max-h-[420px] space-y-2 overflow-auto">
                {detail.events.map((e) => (
                  <li key={e.id} className="text-[12.5px]">
                    <span className="text-fog">{new Date(e.ts).toLocaleTimeString()} </span>
                    <span className={e.kind === "agent.fail" || e.kind === "tool.fail" || e.kind === "context.blowout" ? "text-rose-400" : e.kind === "wait" ? "text-amber-400" : "text-mist"}>{e.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fog">No events recorded.</p>
            )}
          </Panel>
        </div>
      </div>
      )}
    </div>
  );
}
