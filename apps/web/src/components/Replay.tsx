import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Link2, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDuration, fmtTokens, fmtUsd } from "../lib/format";
import { Spinner, useToast } from "./ui";

export interface Timeline {
  id: string;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  events: { id: string; ts: string; kind: string; agentId: string | null; text: string }[];
  asks: { id: string; kind: string; tool: string | null; prompt: string; createdAt: string; closedAt: string | null; outcome: string | null; decision: string | null; answeredBy: string | null; via: string | null }[];
  samples: { ts: string; tokens: number; delta: number; costUsd: number | null; contextUsed: number | null; contextWindow: number | null }[];
  agents: { id: string; parentId: string | null; type: string | null; kind: string; status: string; startedAt: string; endedAt: string | null }[];
  decisions: { ts: string; tool: string; summary: string | null; rule: string; effect: string; enforced: boolean }[];
}

const TONE: Record<string, string> = {
  "agent.fail": "var(--color-rose-400)",
  "tool.fail": "var(--color-rose-400)",
  "context.blowout": "var(--color-rose-400)",
  wait: "var(--color-amber-400)",
  answer: "var(--color-teal-300)",
  "agent.spawn": "var(--color-teal-400)",
  "agent.done": "var(--color-teal-400)",
  "turn.start": "var(--color-snow)",
  "session.start": "var(--color-snow)",
  "session.end": "var(--color-snow)",
};
const tone = (kind: string) => TONE[kind] ?? "var(--color-fog)";

const SPEEDS: [number, string][] = [[20, "20 s"], [45, "45 s"], [90, "90 s"]];

/** Largest value in a sorted-by-time list at or before t (binary search). */
function at<T>(list: T[], t: number, time: (x: T) => number): T | null {
  let lo = 0;
  let hi = list.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time(list[mid]!) <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? list[best]! : null;
}

/** `?t=` as seconds from the start ("754"), or a moment ("2026-10-20T09:12:04Z"). Null when absent or unreadable. */
export function parseMoment(raw: string | null, t0: number): number | null {
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at - t0 : null;
}

/**
 * Replay a session: a scrubber over its whole run with cost, prompts, agents
 * and events laid on it, and a panel that shows the session as it was at the
 * playhead. Space plays and pauses; the arrow keys jump between events. The
 * playhead lives in the URL (`?t=`, seconds from the start), so a moment can
 * be shared.
 */
export function Replay({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [tl, setTl] = useState<Timeline | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(45);
  const trackRef = useRef<HTMLDivElement>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void api.get<Timeline>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/timeline`).then((x) => alive && setTl(x));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // A live session's end is "now", fixed when its timeline loads: recomputing it on every render would
  // move the end under the playhead and stop playback the moment it started.
  const loadedAt = useMemo(() => (tl ? Date.now() : 0), [tl]);
  const t0 = tl ? Date.parse(tl.startedAt) : 0;
  const t1 = tl ? Math.max(t0 + 1000, tl.endedAt ? Date.parse(tl.endedAt) : live ? loadedAt : Date.parse(tl.lastSeenAt)) : 1;
  const span = t1 - t0;
  const x = useCallback((iso: string) => Math.min(1, Math.max(0, (Date.parse(iso) - t0) / span)), [t0, span]);

  // Start where the link points, else at the end so the first view is the whole story. Once per loaded timeline.
  useEffect(() => {
    if (!tl) return;
    const asked = parseMoment(params.get("t"), t0);
    setT(asked === null ? span : Math.min(span, Math.max(0, asked)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // Keep the URL on the moment shown, once the playhead rests: not on every frame of playback.
  const tSec = Math.round(t / 1000);
  useEffect(() => {
    if (!tl || playing) return;
    const id = setTimeout(() => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        if (tSec >= Math.round(span / 1000)) next.delete("t");
        else next.set("t", String(tSec));
        return next;
      }, { replace: true });
    }, 400);
    return () => clearTimeout(id);
  }, [tSec, playing, tl, span, setParams]);

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "replay");
    url.searchParams.set("t", String(tSec));
    void navigator.clipboard?.writeText(url.toString()).then(() => toast("Link to this moment copied."), () => toast("Could not copy the link.", "error"));
  };

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setT((cur) => {
        const next = cur + (dt * span) / (speed * 1000);
        if (next >= span) {
          setPlaying(false);
          return span;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, span, speed]);

  const eventTimes = useMemo(() => (tl ? tl.events.map((e) => Date.parse(e.ts) - t0) : []), [tl, t0]);
  const jump = useCallback(
    (dir: 1 | -1) => {
      setPlaying(false);
      setT((cur) => {
        if (dir > 0) return eventTimes.find((e) => e > cur + 1) ?? span;
        const prev = [...eventTimes].reverse().find((e) => e < cur - 1);
        return prev ?? 0;
      });
    },
    [eventTimes, span],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => {
          if (!p) setT((cur) => (cur >= span ? 0 : cur));
          return !p;
        });
      } else if (e.key === "ArrowRight") jump(1);
      else if (e.key === "ArrowLeft") jump(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, span]);

  const seek = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = trackRef.current!.getBoundingClientRect();
    setT(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span);
  };

  if (!tl) return <div className="flex h-48 items-center justify-center"><Spinner /></div>;

  const now = t0 + t;
  const nowIso = new Date(now).toISOString();
  const sample = at(tl.samples, now, (s) => Date.parse(s.ts));
  const ctxSample = at(tl.samples.filter((s) => s.contextUsed && s.contextWindow), now, (s) => Date.parse(s.ts));
  const ctxNow = ctxSample ? { pct: Math.round((ctxSample.contextUsed! / ctxSample.contextWindow!) * 100), window: ctxSample.contextWindow! } : null;
  const maxCost = Math.max(0.0001, ...tl.samples.map((s) => s.costUsd ?? 0));
  const maxTok = Math.max(1, ...tl.samples.map((s) => s.tokens));
  const useCost = tl.samples.some((s) => s.costUsd !== null);
  const pts = tl.samples.map((s) => [x(s.ts), useCost ? (s.costUsd ?? 0) / maxCost : s.tokens / maxTok] as const);
  const line = pts.length ? [[0, 0] as const, ...pts, [x(nowIso) > (pts.at(-1)?.[0] ?? 0) ? 1 : pts.at(-1)![0], pts.at(-1)![1]] as const] : [];
  const agentsNow = tl.agents.filter((a) => Date.parse(a.startedAt) <= now && (!a.endedAt || Date.parse(a.endedAt) > now) && a.kind !== "orchestrator");
  const openAsk = tl.asks.find((a) => Date.parse(a.createdAt) <= now && (!a.closedAt || Date.parse(a.closedAt) > now));
  const past = tl.events.filter((e) => Date.parse(e.ts) <= now).slice(-9).reverse();
  const H = 96;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { if (!playing && t >= span) setT(0); setPlaying(!playing); }} className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-teal-400 text-ink hover:bg-teal-300" aria-label={playing ? "Pause replay" : "Play replay"}>
          {playing ? <Pause size={16} /> : t >= span ? <RotateCcw size={16} /> : <Play size={16} className="translate-x-px" />}
        </button>
        <button onClick={() => jump(-1)} className="rounded-md p-1.5 text-fog hover:bg-slate-2 hover:text-snow" aria-label="Previous event"><ChevronLeft size={16} /></button>
        <button onClick={() => jump(1)} className="rounded-md p-1.5 text-fog hover:bg-slate-2 hover:text-snow" aria-label="Next event"><ChevronRight size={16} /></button>
        <div className="ml-1 font-mono text-[12.5px] tabular-nums text-snow">{new Date(now).toLocaleTimeString()}</div>
        <div className="text-[12.5px] text-fog">{fmtDuration(t)} in, of {fmtDuration(span)}</div>
        <button onClick={copyLink} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-fog hover:bg-slate-2 hover:text-snow" title="Copy a link that opens the replay at this moment"><Link2 size={13} /> Copy link</button>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-fog">
          Replay in
          <div className="flex rounded-lg border border-line-2 p-0.5" role="group" aria-label="Replay length">
            {SPEEDS.map(([s, l]) => <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s} className={`rounded-md px-2 py-0.5 ${speed === s ? "bg-slate-3 text-snow" : "hover:text-snow"}`}>{l}</button>)}
          </div>
        </div>
      </div>

      <div ref={trackRef} className="relative cursor-pointer select-none touch-none" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setPlaying(false); seek(e); }} onPointerMove={(e) => e.buttons === 1 && seek(e)} role="slider" aria-label="Replay position" aria-valuemin={0} aria-valuemax={Math.round(span / 1000)} aria-valuenow={Math.round(t / 1000)} aria-valuetext={`${fmtDuration(t)} in`} tabIndex={0}>
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" className="block h-24 w-full" aria-hidden="true">
          <defs>
            <clipPath id={`played-${tl.id}`}><rect x={0} y={0} width={(t / span) * 1000} height={H} /></clipPath>
          </defs>
          <line x1={0} x2={1000} y1={H - 0.5} y2={H - 0.5} stroke="var(--color-line-2)" />
          {line.length ? (
            <>
              <polyline points={line.map(([a, b]) => `${a * 1000},${H - 2 - b * (H - 10)}`).join(" ")} fill="none" stroke="var(--color-line-2)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <g clipPath={`url(#played-${tl.id})`}>
                <polygon points={`0,${H} ${line.map(([a, b]) => `${a * 1000},${H - 2 - b * (H - 10)}`).join(" ")} 1000,${H}`} fill="var(--color-teal-400)" opacity={0.12} />
                <polyline points={line.map(([a, b]) => `${a * 1000},${H - 2 - b * (H - 10)}`).join(" ")} fill="none" stroke="var(--color-teal-400)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </g>
            </>
          ) : null}
        </svg>
        <svg viewBox="0 0 1000 54" preserveAspectRatio="none" className="mt-1 block h-[54px] w-full" aria-hidden="true">
          {/* Lane 1: prompts waiting on a person */}
          {tl.asks.map((a) => {
            const s = x(a.createdAt) * 1000;
            const e = (a.closedAt ? x(a.closedAt) : x(nowIso > tl.lastSeenAt ? tl.lastSeenAt : nowIso)) * 1000;
            return <rect key={a.id} x={s} y={2} width={Math.max(3, e - s)} height={12} rx={2} fill="var(--color-amber-400)" opacity={Date.parse(a.createdAt) <= now ? 0.85 : 0.3}><title>{`${a.kind}: ${a.prompt.slice(0, 120)}`}</title></rect>;
          })}
          {/* Lane 2: agents */}
          {tl.agents.filter((a) => a.kind !== "orchestrator").map((a, i) => {
            const s = x(a.startedAt) * 1000;
            const e = (a.endedAt ? x(a.endedAt) : 1) * 1000;
            return <rect key={a.id} x={s} y={20 + (i % 3) * 4} width={Math.max(2, e - s)} height={3} fill={a.status === "failed" ? "var(--color-rose-400)" : "var(--color-teal-400)"} opacity={Date.parse(a.startedAt) <= now ? 0.9 : 0.3}><title>{a.type ?? a.kind}</title></rect>;
          })}
          {/* Lane 3: events and policy decisions */}
          {tl.events.map((e) => <rect key={e.id} x={x(e.ts) * 1000 - 0.75} y={36} width={1.5} height={14} fill={tone(e.kind)} opacity={Date.parse(e.ts) <= now ? 1 : 0.3}><title>{e.text}</title></rect>)}
          {tl.decisions.map((d, i) => <circle key={i} cx={x(d.ts) * 1000} cy={43} r={3.5} fill={d.effect === "deny" ? "var(--color-rose-400)" : "var(--color-amber-400)"} opacity={d.enforced ? 1 : 0.45}><title>{`${d.rule}: ${d.summary ?? d.tool}`}</title></circle>)}
        </svg>
        <motion.div className="pointer-events-none absolute inset-y-0 w-px bg-snow" style={{ left: `${(t / span) * 100}%` }}>
          <span className="absolute -top-1 -left-[5px] h-[11px] w-[11px] rounded-full border-2 border-ink bg-snow" />
        </motion.div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fog">
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-amber-400" /> waiting on a person</span>
        <span className="flex items-center gap-1.5"><span className="h-[3px] w-3 bg-teal-400" /> agents</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-[2px] bg-rose-400" /> failures</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-400" /> policy decisions</span>
        <span className="ml-auto">{useCost ? "Line: estimated cost so far" : "Line: tokens so far"} · Space to play, ← → to step</span>
      </div>

      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        <div className="space-y-3 rounded-xl border border-line bg-ink-2/60 p-3.5 text-[13px]">
          <div>
            <div className="text-[11.5px] text-fog">Cost so far</div>
            <div className="text-[20px] font-semibold tabular-nums text-snow">{fmtUsd(sample?.costUsd ?? 0, 2)}</div>
            <div className="text-[11.5px] text-fog">{fmtTokens(sample?.tokens ?? 0)} tokens</div>
          </div>
          {ctxNow ? (
            <div>
              <div className="text-[11.5px] text-fog">Context</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-3"><div className="h-full rounded-full" style={{ width: `${Math.min(100, ctxNow.pct)}%`, background: ctxNow.pct >= 90 ? "var(--color-rose-400)" : ctxNow.pct >= 80 ? "var(--color-amber-400)" : "var(--color-teal-400)" }} /></div>
              <div className="mt-0.5 text-[11.5px] text-fog">{ctxNow.pct}% of {fmtTokens(ctxNow.window)}</div>
            </div>
          ) : null}
          <div>
            <div className="text-[11.5px] text-fog">Agents working</div>
            {agentsNow.length ? <div className="mt-1 flex flex-wrap gap-1">{agentsNow.slice(0, 8).map((a) => <span key={a.id} className="rounded bg-teal-700/30 px-1.5 py-0.5 text-[11.5px] text-teal-300">{a.type ?? a.kind}</span>)}{agentsNow.length > 8 ? <span className="text-[11.5px] text-fog">+{agentsNow.length - 8}</span> : null}</div> : <div className="text-mist">none</div>}
          </div>
          <div>
            <div className="text-[11.5px] text-fog">Waiting on</div>
            {openAsk ? (
              <div className="mt-1 rounded-lg border border-amber-400/40 bg-amber-400/5 p-2">
                <div className="text-[11.5px] font-medium text-amber-400">{openAsk.kind}{openAsk.tool ? ` · ${openAsk.tool}` : ""} · {fmtDuration(now - Date.parse(openAsk.createdAt))}</div>
                <div className="mt-0.5 line-clamp-3 text-[12.5px] text-snow">{openAsk.prompt}</div>
                {openAsk.closedAt ? <div className="mt-1 text-[11.5px] text-fog">then {openAsk.decision ?? openAsk.outcome?.replace(/_/g, " ")}{openAsk.answeredBy ? ` by ${openAsk.answeredBy}` : ""}{openAsk.via === "slack" ? " from Slack" : ""}, after {fmtDuration(Date.parse(openAsk.closedAt) - Date.parse(openAsk.createdAt))}</div> : null}
              </div>
            ) : <div className="text-mist">nobody</div>}
          </div>
        </div>
        <div className="min-w-0 rounded-xl border border-line bg-ink-2/60 p-3.5">
          <div className="mb-2 text-[11.5px] text-fog">Activity up to this moment</div>
          {past.length ? (
            <ul className="space-y-1.5">
              <AnimatePresence initial={false}>
                {past.map((e) => (
                  <motion.li key={e.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="flex gap-3 text-[12.5px]">
                    <span className="w-16 shrink-0 font-mono text-[11.5px] tabular-nums text-fog">{fmtDuration(Date.parse(e.ts) - t0)}</span>
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone(e.kind) }} />
                    <span className="min-w-0 truncate text-mist" title={e.text}>{e.text}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          ) : <p className="text-[12.5px] text-fog">Nothing yet at this point.</p>}
        </div>
      </div>
    </div>
  );
}
