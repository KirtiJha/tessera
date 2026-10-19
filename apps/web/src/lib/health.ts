import type { SessionView } from "@tessera/contract";
import { sessionKind } from "./fleet";

/**
 * Whether a session deserves a look, and why. Deterministic rules over what
 * the reporter already sends, so the chip on the card, the wall filter and the
 * bell can never disagree. A rule flags; it never acts.
 */
export type HealthLevel = "fine" | "watch" | "attention";

export interface HealthFlag {
  code: "stuck" | "denied" | "context" | "blowouts" | "long-wait" | "no-progress" | "expensive" | "failed-agents";
  level: Exclude<HealthLevel, "fine">;
  label: string;
  detail: string;
}

export interface HealthContext {
  now: number;
  /** Median estimated cost of the live sessions on the wall, for the outlier rule. */
  medianCostUsd: number;
}

const MIN = 60_000;

export function healthFlags(s: SessionView, ctx: HealthContext): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const kind = sessionKind(s);
  if (kind === "done") return flags;
  const activity = s.activity ?? [];
  const recent = activity.slice(-5);

  // The same tool failing again and again is the clearest sign of an agent going in circles.
  const failed = recent.filter((a) => a.status === "failed");
  if (failed.length >= 3) {
    const tools = new Set(failed.map((a) => a.tool));
    flags.push({ code: "stuck", level: "attention", label: "Stuck", detail: `${failed.length} of the last ${recent.length} tool calls failed${tools.size === 1 ? ` (${[...tools][0]})` : ""}` });
  }

  const denied = recent.filter((a) => a.status === "denied");
  if (denied.length >= 3) flags.push({ code: "denied", level: "watch", label: "Hitting policy", detail: `${denied.length} of the last ${recent.length} tool calls were denied` });

  if (s.context) {
    const pct = s.context.used / s.context.window;
    if (pct >= 0.9) flags.push({ code: "context", level: "attention", label: "Context nearly full", detail: `${Math.round(pct * 100)}% of the window; the next compaction loses detail` });
    else if (pct >= 0.8) flags.push({ code: "context", level: "watch", label: "Context filling", detail: `${Math.round(pct * 100)}% of the window` });
  }
  if (s.blowouts >= 2) flags.push({ code: "blowouts", level: "watch", label: `${s.blowouts} blowouts`, detail: "The context window has filled and compacted more than once" });

  if (kind === "waiting" && s.openAsk) {
    const waited = ctx.now - Date.parse(s.openAsk.createdAt);
    if (waited >= 10 * MIN) flags.push({ code: "long-wait", level: "attention", label: `Waiting ${Math.floor(waited / MIN)} min`, detail: "A prompt has waited on a person for over ten minutes" });
  }

  const elapsed = ctx.now - Date.parse(s.startedAt);
  if (kind === "running" && elapsed >= 30 * MIN && activity.length >= 20 && s.filesChanged.length === 0) {
    flags.push({ code: "no-progress", level: "watch", label: "No file changes yet", detail: `${Math.floor(elapsed / MIN)} minutes and ${activity.length}+ tool calls without a change in the working tree` });
  }

  if (s.costUsd !== null && ctx.medianCostUsd > 0 && s.costUsd >= 5 && s.costUsd >= 3 * ctx.medianCostUsd) {
    flags.push({ code: "expensive", level: "watch", label: "Cost outlier", detail: `$${s.costUsd.toFixed(2)}, over three times the wall's median` });
  }

  const failedAgents = s.agents.filter((a) => a.status === "failed").length;
  if (failedAgents >= 2) flags.push({ code: "failed-agents", level: "watch", label: `${failedAgents} agents failed`, detail: "More than one agent in this session has failed" });

  return flags.sort((a, b) => (a.level === b.level ? 0 : a.level === "attention" ? -1 : 1));
}

export function healthLevel(flags: HealthFlag[]): HealthLevel {
  return flags.some((f) => f.level === "attention") ? "attention" : flags.length ? "watch" : "fine";
}

/** The median estimated cost of the sessions given, or 0 with none priced. */
export function medianCost(sessions: SessionView[]): number {
  const costs = sessions.map((s) => s.costUsd).filter((c): c is number => c !== null).sort((a, b) => a - b);
  if (!costs.length) return 0;
  const mid = Math.floor(costs.length / 2);
  return costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
}

/** A ticket id from the session's tags, else from its branch (ABC-123 style). */
export function ticketOf(s: SessionView, pattern = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/): string | null {
  const tagged = s.tags.ticket;
  if (tagged) return tagged;
  const m = s.git?.branch ? pattern.exec(s.git.branch) : null;
  return m ? m[1]! : null;
}
