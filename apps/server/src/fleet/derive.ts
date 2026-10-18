import type { AgentView, ModelPrice, SessionView } from "@tessera/contract";
import { priceFor, totalUsage } from "./pricing.js";
import type { SessionRecord } from "./types.js";

export function deriveSession(rec: SessionRecord, table: ModelPrice[], now: number, staleAfterMs: number): SessionView {
  const sessionPrice = priceFor(totalUsage(rec.usageByModel, rec.agents), table);
  const agents: AgentView[] = rec.agents.map((a) => {
    const p = priceFor(a.usageByModel, table);
    return {
      id: a.id,
      parentId: a.parentId,
      kind: a.kind,
      type: a.type,
      description: a.description,
      model: a.model,
      effort: a.effort,
      status: a.status,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      tokens: a.tokens,
      costUsd: p.usd,
      context: a.context,
      toolCalls: a.toolCalls,
      skills: a.skills,
      failure: a.failure,
      promptExcerpt: a.promptExcerpt,
      answerExcerpt: a.answerExcerpt,
    };
  });
  const stale = rec.status !== "ended" && now - Date.parse(rec.lastSeenAt) > staleAfterMs;
  return {
    id: rec.id,
    orgId: rec.orgId,
    teamId: rec.teamId,
    name: rec.name,
    ownerId: rec.ownerId,
    ownerName: rec.ownerName,
    machine: rec.hostname && rec.machineId ? { hostname: rec.hostname, machineId: rec.machineId } : null,
    reporter: { kind: rec.reporterKind, version: rec.reporterVersion },
    cwd: rec.cwd,
    model: rec.model,
    effort: rec.effort,
    status: rec.status,
    stale,
    waitReason: rec.waitReason,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    endReason: rec.endReason,
    lastSeenAt: rec.lastSeenAt,
    context: rec.contextUsed !== null && rec.contextWindow ? { used: rec.contextUsed, window: rec.contextWindow } : null,
    tokens: rec.tokens,
    costUsd: sessionPrice.usd,
    unpricedModels: sessionPrice.unpriced,
    blowouts: rec.blowouts,
    git: rec.git,
    filesChanged: rec.filesChanged,
    plan: rec.plan,
    agents,
    openAsk: rec.openAsk,
    tags: { ...rec.tags, ...(rec.control.paused ? { paused: rec.control.reason ?? "paused" } : {}) },
    continuedFrom: rec.continuedFrom,
    assignee: rec.control.assignee ? { id: rec.control.assignee.id, name: rec.control.assignee.name } : null,
    stopRequested: !!rec.control.stop,
    activity: rec.activity ?? [],
  };
}
