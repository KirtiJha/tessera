import type { SessionView } from "@tessera/contract";
import { CheckCircle2, CircleAlert, OctagonX, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { fmtDuration, fmtTokens, fmtUsd } from "../lib/format";
import { HELP } from "../lib/help";
import { summarize, type SummaryAsk } from "../lib/summary";
import { Hint } from "./ui";

function Fact({ label, value, sub, help }: { label: string; value: string; sub?: string; help?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-fog">{label}{help ? <Hint label={label.toLowerCase()}>{help}</Hint> : null}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums text-snow">{value}</div>
      {sub ? <div className="truncate text-[11.5px] text-fog">{sub}</div> : null}
    </div>
  );
}

const VERDICT = {
  ok: { icon: CheckCircle2, color: "var(--color-teal-400)", label: "Finished" },
  issues: { icon: CircleAlert, color: "var(--color-amber-400)", label: "Finished, with problems" },
  stopped: { icon: OctagonX, color: "var(--color-rose-400)", label: "Stopped" },
} as const;

/** What an ended session did, on one card: the first thing to read before the detail. */
export function SessionSummary({ s, asks, onReplay }: { s: SessionView; asks: SummaryAsk[]; onReplay: () => void }) {
  const m = summarize(s, asks);
  const v = VERDICT[m.verdict];
  const Icon = v.icon;
  return (
    <section aria-label="Session summary" className="mt-4 rounded-xl border border-line bg-slate-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon size={18} style={{ color: v.color }} aria-hidden="true" />
        <h2 className="text-[15px] font-semibold text-snow">{v.label} after {fmtDuration(m.durationMs)}</h2>
        <span className="text-[13px] text-mist">{m.headline}</span>
        <div className="ml-auto flex items-center gap-3 text-[12.5px]">
          <button onClick={onReplay} className="inline-flex items-center gap-1 text-fog hover:text-teal-300"><Play size={13} /> Replay from the start</button>
          <Link to={`/app/compare?a=${encodeURIComponent(s.id)}`} className="text-fog hover:text-teal-300">Compare →</Link>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact help={`${HELP.cost} ${HELP.cacheShare}`} label="Cost" value={fmtUsd(s.costUsd, 2)} sub={m.cacheShare !== null ? `${Math.round(m.cacheShare * 100)}% of input from cache` : undefined} />
        <Fact label="Tokens" value={fmtTokens(s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite)} sub={`${fmtTokens(s.tokens.output)} written`} />
        <Fact label="Files" value={m.files.count ? `${m.files.count} changed` : "none changed"} sub={m.files.count ? `+${m.files.added} −${m.files.removed}, uncommitted` : m.files.ahead ? `${m.files.ahead} commits ahead` : undefined} />
        <Fact label="Agents" value={m.agents.ran ? `${m.agents.ran} ran` : "none"} sub={m.agents.failed ? `${m.agents.failed} failed` : m.agents.ran ? "none failed" : undefined} />
        <Fact help={HELP.waited} label="Waited on people" value={m.prompts.asked ? fmtDuration(m.prompts.totalWaitMs) : "never"} sub={m.prompts.asked ? `${m.prompts.asked} prompt${m.prompts.asked === 1 ? "" : "s"}, ${m.prompts.answeredHere} answered in Tessera` : undefined} />
        <Fact help={HELP.context} label="Context" value={s.blowouts ? `${s.blowouts} blowout${s.blowouts === 1 ? "" : "s"}` : "no blowouts"} sub={s.context ? `ended at ${Math.round((s.context.used / s.context.window) * 100)}% full` : undefined} />
      </div>
      {m.plan || m.topTools.length ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-[12.5px] text-fog">
          {m.plan ? <span>Plan: <span className="text-mist">{m.plan.done} of {m.plan.total} steps done</span></span> : null}
          {m.topTools.length ? <span>Most used: <span className="text-mist">{m.topTools.map((t) => `${t.tool} ${t.calls}`).join(" · ")}</span></span> : null}
          {m.prompts.longestWaitMs > 60_000 ? <span>Longest wait: <span className="text-mist">{fmtDuration(m.prompts.longestWaitMs)}</span></span> : null}
        </div>
      ) : null}
    </section>
  );
}
