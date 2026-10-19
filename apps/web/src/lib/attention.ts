import type { SessionView } from "@tessera/contract";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { sessionKind, sessionLabel, useSessions } from "./fleet";

/**
 * What needs a person right now, derived in the browser from the live session
 * list (decision 10: live counts never come from a second source) plus the
 * budget statuses the server computes. This is a live list, not a notification
 * log: an item disappears the moment it is dealt with.
 */
export interface AttentionItem {
  id: string;
  kind: "waiting" | "failed" | "budget";
  title: string;
  detail: string;
  href: string;
  /** When it started needing attention; items are shown oldest first within a kind. */
  since: string;
}

export interface BudgetStatus {
  id: string;
  scopeType: "org" | "team" | "user";
  scopeId: string | null;
  scopeName?: string | null;
  window: "daily" | "weekly" | "monthly";
  softUsd: number | null;
  hardUsd: number | null;
  enforce: boolean;
  spentUsd: number;
  level: "ok" | "soft" | "hard";
}

const ASK = { question: "Has a question", plan: "Plan needs approval", permission: "Permission needed" } as const;

export function attentionItems(sessions: SessionView[], budgets: BudgetStatus[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of sessions) {
    const href = `/app/sessions/${encodeURIComponent(s.id)}`;
    if (sessionKind(s) === "waiting") {
      const ask = s.openAsk;
      items.push({
        id: `waiting:${s.id}`,
        kind: "waiting",
        title: `${sessionLabel(s)} · ${ask ? ASK[ask.kind] : "Waiting for input"}`,
        detail: [s.ownerName ?? "Unassigned", ask?.tool, ask?.prompt].filter(Boolean).join(" · "),
        href,
        since: ask?.createdAt ?? s.lastSeenAt,
      });
    }
    if (s.status !== "ended") {
      const failed = s.agents.filter((a) => a.status === "failed");
      if (failed.length) {
        const last = failed.reduce((a, b) => ((a.endedAt ?? a.startedAt) > (b.endedAt ?? b.startedAt) ? a : b));
        items.push({
          id: `failed:${s.id}`,
          kind: "failed",
          title: `${sessionLabel(s)} · ${failed.length} agent${failed.length > 1 ? "s" : ""} failed`,
          detail: [s.ownerName ?? "Unassigned", last.failure?.summary ?? last.type ?? last.kind].filter(Boolean).join(" · "),
          href,
          since: last.endedAt ?? last.startedAt,
        });
      }
    }
  }
  for (const b of budgets) {
    if (b.level === "ok") continue;
    const limit = b.level === "hard" ? b.hardUsd : b.softUsd;
    const who = b.scopeType === "org" ? "Organisation" : (b.scopeName ?? (b.scopeType === "team" ? "A team" : "A person"));
    items.push({
      id: `budget:${b.id}`,
      kind: "budget",
      title: `${who} · ${b.level === "hard" ? "hard" : "soft"} ${b.window} budget reached`,
      detail: `$${b.spentUsd.toFixed(2)} of $${(limit ?? 0).toFixed(2)}${b.level === "hard" && b.enforce ? " · new tool calls are being denied" : ""}`,
      href: "/app/budgets",
      since: "",
    });
  }
  const order = { waiting: 0, failed: 1, budget: 2 };
  return items.sort((a, b) => order[a.kind] - order[b.kind] || a.since.localeCompare(b.since));
}

/** Budget statuses, refreshed every minute and whenever `refreshKey` changes (the bell opening). */
function useBudgets(refreshKey: number): BudgetStatus[] {
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<{ budgets: BudgetStatus[] }>("/api/admin/budgets").then((r) => alive && setBudgets(r.budgets)).catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshKey]);
  return budgets;
}

export function useAttention(refreshKey = 0): AttentionItem[] {
  const sessions = useSessions();
  const budgets = useBudgets(refreshKey);
  return useMemo(() => attentionItems(sessions, budgets), [sessions, budgets]);
}
