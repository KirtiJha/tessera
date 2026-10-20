import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { ago } from "../lib/format";

interface Context {
  step: { title: string; index: number; of: number } | null;
  files: { path: string; status: string; added: number; removed: number }[];
  filesTotal: number;
  failures: { tool: string; summary: string; error: string | null; ts: string }[];
  program: string | null;
  history: { allowed: number; denied: number; lastAt: string | null; lastBy: string | null; byMe: number } | null;
}

/**
 * What an approver wants to know beside the command itself: where the session
 * is in its plan, what it has touched, what last went wrong, and how calls
 * like this one have been decided before. When the same thing keeps being
 * allowed, the history offers to become a team rule instead of another click.
 */
export function DecisionContext({ sessionId, askId, tool, kind, now }: { sessionId: string; askId: string; tool: string | null; kind: string; now: number }) {
  const [ctx, setCtx] = useState<Context | null>(null);
  useEffect(() => {
    let alive = true;
    setCtx(null);
    void api.get<Context>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/decision`).then((c) => alive && setCtx(c)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, askId]);
  if (!ctx) return null;
  const h = ctx.history;
  // Repeated, never-denied approvals are what Policies offers as "always allow"; send the approver there.
  const repeated = !!h && kind === "permission" && h.allowed >= 3 && h.denied === 0;
  const rows: { k: string; v: React.ReactNode }[] = [];
  if (ctx.step) rows.push({ k: "Plan", v: <>step {ctx.step.index} of {ctx.step.of}: <span className="text-snow">{ctx.step.title}</span></> });
  if (ctx.files.length) rows.push({ k: "Touched", v: <>{ctx.files.map((f) => <span key={f.path} className="mr-2 font-mono text-[11.5px]">{f.path.split("/").slice(-2).join("/")} <span className="text-teal-300">+{f.added}</span> <span className="text-rose-400">−{f.removed}</span></span>)}{ctx.filesTotal > ctx.files.length ? <span className="text-ash">+{ctx.filesTotal - ctx.files.length} more</span> : null}</> });
  if (ctx.failures.length) rows.push({ k: "Last failed", v: <span className="font-mono text-[11.5px]">{ctx.failures[0]!.summary}{ctx.failures[0]!.error ? <span className="text-rose-400"> — {ctx.failures[0]!.error.split("\n")[0]}</span> : null}</span> });
  if (h && (h.allowed || h.denied)) {
    rows.push({
      k: "Before",
      v: (
        <>
          {ctx.program ? <span className="font-mono text-[11.5px]">{tool}({ctx.program}…)</span> : tool} was <span className="text-teal-300">allowed {h.allowed}×</span>{h.denied ? <> and <span className="text-rose-400">denied {h.denied}×</span></> : null} for this person in 30 days{h.lastBy ? <>, last by {h.lastBy}{h.lastAt ? ` ${ago(h.lastAt, now)}` : ""}</> : null}.
          {repeated ? <> <Link to="/app/policies" className="text-teal-300 underline-offset-2 hover:underline">See suggested rules</Link></> : null}
        </>
      ),
    });
  }
  if (!rows.length) return null;
  return (
    <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-amber-400/20 pt-2.5 text-[12px] text-mist" data-testid="decision-context">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-fog">{r.k}</dt>
          <dd className="min-w-0 break-words">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
