import { useEffect, useMemo, useState } from "react";
import { keyOf, useAgentFocus } from "../lib/agentFocus";
import { api } from "../lib/api";
import { fmtDuration, fmtTime } from "../lib/format";

/** The slice of the timeline endpoint this view draws. */
interface Data {
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  events: { id: string; ts: string; kind: string; agentId: string | null; text: string }[];
  asks: { id: string; kind: string; tool: string | null; prompt: string; createdAt: string; closedAt: string | null; outcome: string | null; answeredBy: string | null }[];
  agents: { id: string; parentId: string | null; type: string | null; kind: string; status: string; startedAt: string; endedAt: string | null }[];
  decisions: { ts: string; tool: string; summary: string | null; rule: string; effect: string; enforced: boolean }[];
  samples: { ts: string; contextUsed: number | null; contextWindow: number | null }[];
}

const ROW = 22;
const LEFT = 132;
const MAX_ROWS = 14;
/** Height of the context strip under the lanes. */
const CTX_H = 54;

const AGENT_TONE: Record<string, string> = { running: "var(--color-teal-400)", done: "var(--color-teal-700)", failed: "var(--color-rose-400)", aborted: "var(--color-amber-500)" };

/**
 * The session as a picture: one lane for the session itself, one per agent,
 * each a bar from start to end coloured by how it ended; the prompts that
 * waited on a person as amber spans across the top; failures and policy
 * denials as marks; and under them how full the context window was, minute
 * by minute, with the 80% and 90% lines and each compaction. A click on a
 * mark opens the replay at that moment. Hand-drawn SVG, no library, both themes.
 */
export function SessionTimeline({ id, live, onSeek }: { id: string; live: boolean; onSeek?: (secondsFromStart: number) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [now, setNow] = useState(Date.now());
  const { focus, actor } = useAgentFocus();
  // The session's own lane stands for its main work when that is in focus.
  const dim = (laneId: string) => focus !== null && (laneId === "session" ? focus !== "main" : laneId !== focus);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Data>(`/api/fleet/sessions/${encodeURIComponent(id)}/timeline`).then((d) => alive && setData(d)).catch(() => {});
    void load();
    const t = live ? setInterval(() => { void load(); setNow(Date.now()); }, 15_000) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [id, live]);

  const model = useMemo(() => {
    if (!data) return null;
    const t0 = Date.parse(data.startedAt);
    const t1 = Math.max(t0 + 60_000, data.endedAt ? Date.parse(data.endedAt) : Math.max(Date.parse(data.lastSeenAt), live ? now : 0));
    const agents = data.agents.filter((a) => a.kind !== "orchestrator").sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const shown = agents.slice(0, MAX_ROWS - 1);
    const lanes = [{ id: "session", label: "session", status: data.endedAt ? "done" : "running", start: t0, end: t1 }, ...shown.map((a) => ({ id: a.id, label: a.type ?? "agent", status: a.status, start: Date.parse(a.startedAt), end: a.endedAt ? Date.parse(a.endedAt) : t1 }))];
    const fails = data.events.filter((e) => e.kind === "tool.fail" || e.kind === "agent.fail" || e.kind === "context.blowout");
    const turns = data.events.filter((e) => e.kind === "turn.start");
    const denials = data.decisions.filter((d) => d.effect === "deny" && d.enforced);
    const ctx = (data.samples ?? []).filter((x) => x.contextUsed && x.contextWindow).map((x) => ({ t: Date.parse(x.ts), pct: Math.min(1, x.contextUsed! / x.contextWindow!) }));
    const compactions = data.events.filter((e) => e.kind === "context.blowout" || e.kind === "context.compact");
    return { t0, t1, lanes, hidden: agents.length - shown.length, fails, turns, denials, asks: data.asks, ctx, compactions };
  }, [data, live, now]);

  if (!data || !model) return <p className="text-[12.5px] text-fog">Loading the timeline…</p>;
  const { t0, t1, lanes } = model;
  const span = t1 - t0;
  const width = 760;
  const plotW = width - LEFT - 8;
  const x = (t: number) => LEFT + Math.max(0, Math.min(1, (t - t0) / span)) * plotW;
  const lanesBottom = 28 + lanes.length * ROW;
  const ctxTop = lanesBottom + 10;
  const hasCtx = model.ctx.length > 0;
  const height = lanesBottom + (hasCtx ? CTX_H + 14 : 0) + 24;
  const cy = (pct: number) => ctxTop + CTX_H - pct * CTX_H;
  // A step line: each minute's reading holds until the next one.
  const ctxPath = model.ctx.map((p, i) => (i ? `H${x(p.t)} V${cy(p.pct)}` : `M${x(p.t)} ${cy(p.pct)}`)).join(" ") + (model.ctx.length ? ` H${x(live && !data.endedAt ? now : t1)}` : "");
  // Up to the next whole second, so the replay opens with the clicked moment already in its activity.
  const seek = onSeek ? (iso: string) => () => onSeek(Math.max(0, Math.ceil((Date.parse(iso) - t0) / 1000))) : null;
  const clickable = onSeek ? { cursor: "pointer" } : undefined;
  const ticks = 6;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 520 }} role="img" aria-label={`Timeline of the session: ${lanes.length} lanes over ${fmtDuration(span)}`} className="text-[10.5px]">
        {/* grid and time labels */}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const t = t0 + (span * i) / ticks;
          return (
            <g key={i}>
              <line x1={x(t)} x2={x(t)} y1={22} y2={height - 20} stroke="var(--color-line)" strokeDasharray="2 3" />
              <text x={x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === ticks ? "end" : "middle"} fill="var(--color-fog)">{fmtTime(new Date(t).toISOString())}</text>
            </g>
          );
        })}
        {/* prompts waiting on a person: amber spans along the top */}
        {model.asks.map((a) => {
          const s = Date.parse(a.createdAt);
          const e = a.closedAt ? Date.parse(a.closedAt) : t1;
          return (
            <g key={a.id}>
              <rect x={x(s)} y={6} width={Math.max(2, x(e) - x(s))} height={10} rx={2} fill="var(--color-amber-400)" opacity={a.closedAt ? 0.55 : 0.95} style={clickable} onClick={seek?.(a.createdAt)}>
                <title>{`${a.kind} · ${a.tool ?? ""} ${a.prompt.slice(0, 120)}\nwaited ${fmtDuration(e - s)}${a.answeredBy ? ` · ${a.outcome ?? "answered"} by ${a.answeredBy}` : a.closedAt ? ` · ${a.outcome ?? "closed"}` : " · still waiting"}`}</title>
              </rect>
            </g>
          );
        })}
        <text x={LEFT - 6} y={14} textAnchor="end" fill="var(--color-ash)">waiting on you</text>
        {/* lanes */}
        {lanes.map((l, i) => {
          const y = 28 + i * ROW;
          const who = i === 0 ? null : actor(l.id);
          const hue = who?.color ?? null;
          const label = who && who.label !== "agent" ? who.label : l.label;
          return (
            <g key={l.id} opacity={dim(l.id) ? 0.3 : 1}>
              {hue ? <rect x={LEFT - 3} y={y + 5} width={2} height={12} fill={hue} /> : null}
              <text x={LEFT - 6} y={y + 14} textAnchor="end" fill={i === 0 ? "var(--color-snow)" : (hue ?? "var(--color-mist)")} fontWeight={i === 0 || !dim(l.id) && focus ? 600 : 400}>{label.length > 18 ? `${label.slice(0, 17)}…` : label}</text>
              <rect x={x(l.start)} y={y + 5} width={Math.max(2, x(l.end) - x(l.start))} height={12} rx={3} fill={AGENT_TONE[l.status] ?? "var(--color-slate-3)"} opacity={i === 0 ? 0.35 : 0.9}>
                <title>{`${l.label} · ${l.status} · ${fmtDuration(l.end - l.start)}`}</title>
              </rect>
            </g>
          );
        })}
        {/* turns as faint ticks on the session lane */}
        {model.turns.map((e) => <line key={e.id} x1={x(Date.parse(e.ts))} x2={x(Date.parse(e.ts))} y1={30} y2={50} stroke="var(--color-fog)" opacity={0.6}><title>{e.text}</title></line>)}
        {/* failures and enforced denials as marks on their lane */}
        {model.fails.map((e) => {
          const lane = Math.max(0, lanes.findIndex((l) => l.id === e.agentId));
          const cx = x(Date.parse(e.ts));
          const cy = 28 + lane * ROW + 11;
          return <path key={e.id} d={`M${cx} ${cy - 5} L${cx + 5} ${cy} L${cx} ${cy + 5} L${cx - 5} ${cy} Z`} fill="var(--color-rose-400)" opacity={focus && keyOf(e.agentId) !== focus ? 0.3 : 1} style={clickable} onClick={seek?.(e.ts)}><title>{`${e.text}${onSeek ? "\nClick to replay from here" : ""}`}</title></path>;
        })}
        {model.denials.map((d, i) => <circle key={i} cx={x(Date.parse(d.ts))} cy={39} r={3.5} fill="var(--color-violet-400)" style={clickable} onClick={seek?.(d.ts)}><title>{`policy "${d.rule}" denied ${d.tool}${d.summary ? `: ${d.summary}` : ""}`}</title></circle>)}
        {hasCtx ? (
          <g aria-label="Context window fill">
            <text x={LEFT - 6} y={ctxTop + 12} textAnchor="end" fill="var(--color-snow)" fontWeight={600}>context</text>
            <text x={LEFT - 6} y={ctxTop + 25} textAnchor="end" fill="var(--color-ash)">{`${Math.round((model.ctx.at(-1)?.pct ?? 0) * 100)}% now`}</text>
            <rect x={LEFT} y={ctxTop} width={plotW} height={CTX_H} fill="var(--color-slate-2)" opacity={0.5} rx={3} />
            {[0.8, 0.9].map((v) => (
              <g key={v}>
                <line x1={LEFT} x2={LEFT + plotW} y1={cy(v)} y2={cy(v)} stroke={v === 0.9 ? "var(--color-rose-400)" : "var(--color-amber-400)"} strokeDasharray="3 3" opacity={0.7} />
                <text x={LEFT + plotW - 2} y={cy(v) - 2} textAnchor="end" fill={v === 0.9 ? "var(--color-rose-400)" : "var(--color-amber-400)"} fontSize={9}>{`${v * 100}%`}</text>
              </g>
            ))}
            <path d={`${ctxPath} V${ctxTop + CTX_H} H${x(model.ctx[0]!.t)} Z`} fill="var(--color-teal-400)" opacity={0.15} />
            <path d={ctxPath} fill="none" stroke="var(--color-teal-400)" strokeWidth={1.5} />
            {model.ctx.map((p) => <rect key={p.t} x={x(p.t) - 3} y={ctxTop} width={6} height={CTX_H} fill="transparent"><title>{`${fmtTime(new Date(p.t).toISOString())} · ${Math.round(p.pct * 100)}% of the context window`}</title></rect>)}
            {model.compactions.map((e) => (
              <g key={e.id} style={clickable} onClick={seek?.(e.ts)}>
                <line x1={x(Date.parse(e.ts))} x2={x(Date.parse(e.ts))} y1={ctxTop - 2} y2={ctxTop + CTX_H + 2} stroke={e.kind === "context.blowout" ? "var(--color-rose-400)" : "var(--color-fog)"} strokeWidth={1.5} />
                <title>{`${e.text}${onSeek ? "\nClick to replay from here" : ""}`}</title>
              </g>
            ))}
          </g>
        ) : null}
        {live && !data.endedAt ? <line x1={x(now)} x2={x(now)} y1={22} y2={height - 20} stroke="var(--color-teal-400)" strokeWidth={1.5} /> : null}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fog">
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-amber-400 align-middle" />waiting on a person</span>
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-teal-400 align-middle" />running</span>
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-teal-700 align-middle" />done</span>
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-rose-400 align-middle" />failed · failure mark</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-violet-400 align-middle" />policy denial</span>
        {hasCtx ? <span><i className="mr-1 inline-block h-[2px] w-3 bg-teal-400 align-middle" />context fill · <span className="text-rose-400">|</span> compaction</span> : null}
        {onSeek ? <span className="text-ash">Click a mark to replay from there</span> : null}
        {model.hidden > 0 ? <span className="text-ash">{model.hidden} more agent{model.hidden === 1 ? "" : "s"} not drawn</span> : null}
      </div>
    </div>
  );
}
