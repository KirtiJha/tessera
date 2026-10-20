import type { SessionView } from "@tessera/contract";

export interface SummaryAsk {
  createdAt: string;
  closedAt: string | null;
  outcome: string | null;
  answeredBy: string | null;
}

export interface SessionSummary {
  durationMs: number;
  /** "ok" when nothing failed, "issues" when an agent failed or the context blew out, "stopped" when it was stopped or aborted. */
  verdict: "ok" | "issues" | "stopped";
  headline: string;
  files: { count: number; added: number; removed: number; ahead: number };
  agents: { ran: number; failed: number };
  prompts: { asked: number; answeredHere: number; totalWaitMs: number; longestWaitMs: number };
  plan: { done: number; total: number } | null;
  topTools: { tool: string; calls: number }[];
  cacheShare: number | null;
}

const STOPPED = /stop|abort|kill|interrupt|logout/i;

/** The story of an ended session in numbers, from what the reporter already sent. */
export function summarize(s: SessionView, asks: SummaryAsk[]): SessionSummary {
  const end = Date.parse(s.endedAt ?? s.lastSeenAt);
  const durationMs = Math.max(0, end - Date.parse(s.startedAt));
  const agents = s.agents.filter((a) => a.kind !== "orchestrator");
  const failed = agents.filter((a) => a.status === "failed").length;
  const waits = asks.map((a) => Math.max(0, Date.parse(a.closedAt ?? s.endedAt ?? s.lastSeenAt) - Date.parse(a.createdAt)));
  const tools = new Map<string, number>();
  for (const [t, n] of Object.entries(s.toolCalls ?? {})) tools.set(t, (tools.get(t) ?? 0) + n);
  for (const a of s.agents) for (const [t, n] of Object.entries(a.toolCalls ?? {})) tools.set(t, (tools.get(t) ?? 0) + n);
  const tokIn = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
  const steps = s.plan?.steps ?? [];
  const verdict = STOPPED.test(s.endReason ?? "") || s.stopRequested ? "stopped" : failed || s.blowouts ? "issues" : "ok";
  const files = { count: s.filesChanged.length, added: s.filesChanged.reduce((n, f) => n + f.added, 0), removed: s.filesChanged.reduce((n, f) => n + f.removed, 0), ahead: s.git?.ahead ?? 0 };
  const headline =
    verdict === "stopped"
      ? "Stopped before it finished."
      : files.count || files.ahead
        ? `Left ${files.count ? `${files.count} file${files.count === 1 ? "" : "s"} changed` : "a clean tree"}${files.ahead ? ` and ${files.ahead} commit${files.ahead === 1 ? "" : "s"} to push` : ""}.`
        : "Changed no files.";
  return {
    durationMs,
    verdict,
    headline,
    files,
    agents: { ran: agents.length, failed },
    prompts: { asked: asks.length, answeredHere: asks.filter((a) => a.outcome === "answered" && a.answeredBy).length, totalWaitMs: waits.reduce((n, w) => n + w, 0), longestWaitMs: waits.length ? Math.max(...waits) : 0 },
    plan: steps.length ? { done: steps.filter((p) => p.status === "completed").length, total: steps.length } : null,
    topTools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tool, calls]) => ({ tool, calls })),
    cacheShare: tokIn ? s.tokens.cacheRead / tokIn : null,
  };
}
