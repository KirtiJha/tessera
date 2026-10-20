import { applyDlp, clean, riskForAsk, totalTokens, type DecideRequest, type DecideResponse, type ActivityEvent, type EventView, type FleetSnapshot, type Report, type ReportAck, type SessionView } from "@tessera/contract";
import type { FastifyBaseLogger } from "fastify";
import type { DevicePrincipal } from "../auth/devices.js";
import { config } from "../config.js";
import { ingestPool, pool, withTx } from "../db/pool.js";
import { hasDelayedChannels, notify, resolveNotifications, type Notification } from "../notify/notifier.js";
import { prefsFor, pushTo, type PushPayload } from "../notify/personal.js";
import { applicable, budgetStatuses, recordBreach } from "./budgets.js";
import { deriveSession } from "./derive.js";
import { computeKpis } from "./kpis.js";
import { DEFAULT_DATA, dataSettingsFor, type DataSettings } from "./datasettings.js";
import { activePolicy, callFrom, evaluatePolicy, recordDecisions, summaryOf } from "./policy.js";
import { priceFor, priceTableFor, totalUsage } from "./pricing.js";
import { rollupDays, utcDay } from "./rollup.js";
import { pumpAuditStreams } from "../compliance/stream.js";
import * as store from "./store.js";
import type { StreamHub } from "./stream.js";
import type { SessionRecord } from "./types.js";

export type DeliveryKind = ReportAck["deliveries"][number]["kind"];

const STREAM_FLUSH_MS = 500;
const SAMPLE_FLUSH_MS = 5000;
const DEVICE_TOUCH_MS = 30_000;

function compareMinor(v: string, min: string, max: string): "ok" | "outdated" | "newer" | "unknown" {
  const parse = (s: string) => {
    const m = /^(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2])] as const : null;
  };
  const a = parse(v);
  const lo = parse(min);
  const hi = parse(max);
  if (!a || !lo || !hi) return "unknown";
  const cmp = (x: readonly [number, number], y: readonly [number, number]) => (x[0] === y[0] ? x[1] - y[1] : x[0] - y[0]);
  if (cmp(a, lo) < 0) return "outdated";
  if (cmp(a, hi) > 0) return "newer";
  return "ok";
}

/** Scrub every free-text field of a report in place. */
/**
 * Scrub every free-text field of a report in place: secrets always, then the
 * organisation's data-loss classes. With excerpts off (metadata-only), prompt
 * and answer text is dropped before it is stored.
 */
function sanitise(r: Report, data: DataSettings = DEFAULT_DATA): void {
  const dlpOn = data.dlp.emails || data.dlp.cards || data.dlp.nationalIds || data.dlp.ibans || data.dlp.terms.length > 0;
  const t = (text: string, max: number) => {
    const c = clean(text, max);
    return dlpOn ? applyDlp(c, data.dlp) : c;
  };
  const s = r.session;
  if (!data.excerpts) {
    // The reporter names a session after its first prompt line; that is prompt text too.
    s.name = null;
    for (const a of s.agents) {
      a.promptExcerpt = null;
      a.answerExcerpt = null;
    }
    for (const e of r.events) if (e.kind === "turn.start") e.text = "prompt submitted";
  }
  s.name = s.name && t(s.name, 200);
  s.cwd = s.cwd && t(s.cwd, 400);
  if (s.git) {
    s.git.repo = s.git.repo && t(s.git.repo, 200);
    s.git.branch = s.git.branch && t(s.git.branch, 200);
    s.git.worktree = s.git.worktree && t(s.git.worktree, 400);
  }
  for (const f of s.filesChanged) f.path = t(f.path, 400);
  if (s.plan) {
    s.plan.title = s.plan.title && t(s.plan.title, 300);
    for (const st of s.plan.steps) st.title = t(st.title, 300);
  }
  if (s.openAsk) {
    s.openAsk.prompt = t(s.openAsk.prompt, 4000);
    s.openAsk.options = s.openAsk.options.map((o) => t(o, 300));
    const d = s.openAsk.detail;
    if (d) {
      d.command = d.command && t(d.command, 4000);
      d.description = d.description && t(d.description, 500);
      d.url = d.url && t(d.url, 1000);
      d.paths = d.paths.map((p) => t(p, 400));
      d.rationale = data.excerpts ? d.rationale && t(d.rationale, 1500) : null;
      d.forcedBy = d.forcedBy && t(d.forcedBy, 400);
      for (const e of d.edits) {
        e.path = t(e.path, 400);
        e.before = t(e.before, 6000);
        e.after = t(e.after, 6000);
      }
      if (d.write) {
        d.write.path = t(d.write.path, 400);
        d.write.excerpt = t(d.write.excerpt, 6000);
      }
      for (const r of d.suggestedRules) {
        r.tool = t(r.tool, 120);
        r.content = r.content && t(r.content, 300);
      }
      for (const q of d.questions) {
        q.question = t(q.question, 1000);
        q.header = q.header && t(q.header, 60);
        for (const o of q.options) {
          o.label = t(o.label, 300);
          o.description = o.description && t(o.description, 500);
        }
      }
    }
  }
  for (const a of s.activity) {
    a.summary = t(a.summary, 300);
    a.error = a.error && t(a.error, 300);
  }
  for (const a of s.agents) {
    a.description = a.description && t(a.description, 400);
    a.promptExcerpt = a.promptExcerpt && t(a.promptExcerpt, 400);
    a.answerExcerpt = a.answerExcerpt && t(a.answerExcerpt, 400);
    if (a.failure) {
      a.failure.summary = t(a.failure.summary, 500);
      a.failure.outputTail = a.failure.outputTail.map((l) => t(l, 240));
    }
  }
  for (const e of r.events) e.text = t(e.text, 500);
  for (const k of Object.keys(s.tags)) s.tags[k] = t(s.tags[k] ?? "", 200);
}

/** What a chat message says about an open prompt: the prompt, then the agent's reason and the risk flags. */
export function waitingText(rec: SessionRecord): string {
  const ask = rec.openAsk;
  if (!ask) return `Reason: ${rec.waitReason ?? "input"}`;
  const lines = [ask.prompt.slice(0, 500)];
  const d = ask.detail;
  if (d?.command && d.command.length > ask.prompt.length - 6) lines[0] = `\`${d.command.slice(0, 500)}\``;
  if (d?.rationale) lines.push(`_${d.rationale.slice(0, 300)}_`);
  const risk = riskForAsk(ask.tool, d, rec.cwd);
  if (risk.length) lines.push(`⚠ ${risk.map((f) => f.label).join(" · ")}`);
  if (d?.forcedBy) lines.push(`Policy: ${d.forcedBy.slice(0, 200)}`);
  return lines.join("\n").slice(0, 1500);
}

function waitingFields(rec: SessionRecord): Record<string, string> {
  const d = rec.openAsk?.detail;
  const out: Record<string, string> = {};
  if (d?.edits.length) out.Files = d.edits.map((e) => e.path).slice(0, 5).join(", ").slice(0, 300);
  else if (d?.write) out.File = `${d.write.path} (${d.write.lines} lines)`.slice(0, 300);
  const last = (rec.activity ?? []).filter((a) => a.status !== "running").slice(-3).map((a) => a.summary.slice(0, 80));
  if (last.length) out["Just before"] = last.join(" → ").slice(0, 300);
  return out;
}

/** One or two lines for a phone notification: the command or the prompt, then the risk flags. */
export function pushText(rec: SessionRecord): string {
  const ask = rec.openAsk;
  if (!ask) return rec.waitReason === "question" ? "Has a question for you." : "Waiting for input.";
  const d = ask.detail;
  const what = d?.command ?? (d?.edits.length ? `Edit ${d.edits.map((e) => e.path.split("/").pop()).join(", ")}` : d?.write ? `Write ${d.write.path.split("/").pop()}` : ask.prompt);
  const risk = riskForAsk(ask.tool, d, rec.cwd).filter((f) => f.level !== "info");
  return `${what.slice(0, 220)}${risk.length ? `\n⚠ ${risk.map((f) => f.label).join(" · ")}` : ""}`;
}

/** One key per thing a session waits on: the open prompt's id, else the wait reason. */
export function waitKeyFor(orgId: string, sessionId: string, what: string): string {
  return `${orgId}:${sessionId}:${what}`;
}

export class Fleet {
  /** orgId → sessionId → record */
  private live = new Map<string, Map<string, SessionRecord>>();
  private lastTokens = new Map<string, number>();
  /** Sessions changed since the last stream flush, and events waiting to go out, per org. */
  private dirty = new Map<string, Set<string>>();
  private outEvents = new Map<string, EventView[]>();
  /** Last written form of each agent, so a report only writes the agents that changed. */
  private agentSig = new Map<string, Map<string, string>>();
  /** Per-minute sample buckets waiting to be written. */
  private samples = new Map<string, store.SampleRow>();
  /** Last time each device's last_seen_at was written. */
  private deviceSeen = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  /** Sessions waiting on a person, by wait key, with what to send and since when (for delayed channels). */
  private waiting = new Map<string, { orgId: string; sessionId: string; since: number; n: Notification }>();

  constructor(
    private hub: StreamHub,
    private log: FastifyBaseLogger,
  ) {
    // With several replicas, each holds the whole live set: a report or an
    // action on one is applied on the others, so any replica can answer for
    // any session. Browsers are told once, by the replica that made the change.
    hub.listen((m) => {
      if (m.op === "set") {
        const rec = m.rec as SessionRecord;
        const key = `${m.orgId}:${rec.id}`;
        this.orgMap(m.orgId).set(rec.id, rec);
        this.lastTokens.delete(key);
        this.agentSig.delete(key);
      } else {
        this.orgMap(m.orgId).delete(m.id);
        this.lastTokens.delete(`${m.orgId}:${m.id}`);
        this.agentSig.delete(`${m.orgId}:${m.id}`);
      }
    });
  }

  async start(): Promise<void> {
    const recs = await store.loadLiveSessions(config.lingerMs);
    for (const r of recs) this.orgMap(r.orgId).set(r.id, r);
    this.log.info({ sessions: recs.length }, "fleet: live set loaded");
    this.timers.push(setInterval(() => void this.sweep().catch((e) => this.log.error({ err: e }, "sweep failed")), 1000));
    this.timers.push(setInterval(() => void this.tick().catch((e) => this.log.error({ err: e }, "tick failed")), 2000));
    this.timers.push(setInterval(() => void this.flushStream().catch((e) => this.log.error({ err: e }, "stream flush failed")), STREAM_FLUSH_MS));
    this.timers.push(setInterval(() => void this.flushSamples().catch((e) => this.log.error({ err: e }, "sample flush failed")), SAMPLE_FLUSH_MS));
    // Audit log to each organisation's SIEM.
    this.timers.push(setInterval(() => void pumpAuditStreams(this.log).catch((e) => this.log.error({ err: e }, "audit stream pump failed")), 15_000));
    // Daily spend rollup: backfill what the samples still hold, then keep today and yesterday current.
    const day = 86_400_000;
    void rollupDays(utcDay(Date.now() - config.retainSamplesDays * day), utcDay(Date.now())).catch((e) => this.log.error({ err: e }, "rollup backfill failed"));
    this.timers.push(setInterval(() => void rollupDays(utcDay(Date.now() - day), utcDay(Date.now())).catch((e) => this.log.error({ err: e }, "rollup failed")), 5 * 60_000));
    this.timers.push(
      setInterval(
        () => void store.prune(config.retainSamplesDays, config.retainEventsDays, config.retainSessionsDays).catch((e) => this.log.error({ err: e }, "prune failed")),
        60 * 60 * 1000,
      ),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.flushSamples().catch((e) => this.log.error({ err: e }, "final sample flush failed"));
  }

  private orgMap(orgId: string): Map<string, SessionRecord> {
    let m = this.live.get(orgId);
    if (!m) this.live.set(orgId, (m = new Map()));
    return m;
  }

  get(orgId: string, id: string): SessionRecord | undefined {
    return this.live.get(orgId)?.get(id);
  }

  async view(rec: SessionRecord): Promise<SessionView> {
    return deriveSession(rec, await priceTableFor(rec.orgId), Date.now(), config.staleAfterMs);
  }

  async views(orgId: string): Promise<SessionView[]> {
    const table = await priceTableFor(orgId);
    const now = Date.now();
    return [...this.orgMap(orgId).values()].map((r) => deriveSession(r, table, now, config.staleAfterMs));
  }

  async snapshot(orgId: string): Promise<FleetSnapshot> {
    const sessions = await this.views(orgId);
    const [kpis, recent] = await Promise.all([computeKpis(orgId, sessions), store.recentEvents(orgId, 150)]);
    return {
      serverTime: new Date().toISOString(),
      config: { staleAfterMs: config.staleAfterMs, dropAfterMs: config.dropAfterMs, lingerMs: config.lingerMs },
      sessions,
      kpis,
      recentEvents: recent,
    };
  }

  totalLive(): number {
    let n = 0;
    for (const m of this.live.values()) n += m.size;
    return n;
  }

  /** Count of live, non-ended sessions for the reporter's status line. */
  liveCount(orgId: string): number {
    let n = 0;
    for (const r of this.orgMap(orgId).values()) if (r.status !== "ended") n++;
    return n;
  }

  // ---- ingest ----------------------------------------------------------

  async ingest(report: Report, device: DevicePrincipal, ip: string | undefined): Promise<ReportAck> {
    sanitise(report, await dataSettingsFor(device.orgId));
    const now = new Date().toISOString();
    const s = report.session;
    const orgId = device.orgId;
    const existing = this.get(orgId, s.id) ?? (await store.loadSession(orgId, s.id));

    if (existing && existing.ownerId && existing.ownerId !== device.userId) {
      throw Object.assign(new Error("session belongs to another user"), { statusCode: 409 });
    }

    const rec: SessionRecord = {
      orgId,
      id: s.id,
      teamId: device.teamId,
      ownerId: device.userId,
      ownerName: device.userName,
      deviceId: device.deviceId,
      name: s.name,
      reporterKind: report.reporter.kind,
      reporterVersion: report.reporter.version,
      reporterFeatures: report.reporter.features,
      hostname: report.machine.hostname,
      machineId: report.machine.machineId,
      cwd: s.cwd,
      model: s.model,
      effort: s.effort,
      status: s.status,
      waitReason: s.waitReason,
      startedAt: existing?.startedAt ?? s.startedAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      lastSeenAt: now,
      droppedAt: null,
      contextUsed: s.context?.used ?? null,
      contextWindow: s.context?.window ?? null,
      tokens: s.tokens,
      usageByModel: s.usageByModel,
      ledgerCostUsd: s.ledgerCostUsd,
      blowouts: s.blowouts,
      git: s.git,
      filesChanged: s.filesChanged,
      plan: s.plan,
      openAsk: s.openAsk,
      tags: s.tags,
      continuedFrom: s.continuedFrom,
      control: existing?.control ?? { paused: false, reason: null, by: null },
      agents: s.agents,
      activity: s.activity,
      toolCalls: s.toolCalls,
    };
    if (rec.status === "ended" && !rec.endedAt) rec.endedAt = now;
    // A stop that never met a tool call is moot once the turn is over.
    if (rec.control.stop && rec.status !== "running") {
      rec.control = { ...rec.control, stop: null };
      void store.setControl(orgId, rec.id, rec.control).catch(() => {});
    }

    const table = await priceTableFor(orgId);
    const usage = totalUsage(rec.usageByModel, rec.agents);
    const cost = priceFor(usage, table).usd;
    const total = totalTokens(rec.tokens) + rec.agents.reduce((n, a) => n + totalTokens(a.tokens), 0);
    const key = `${orgId}:${s.id}`;
    const prevTotal = this.lastTokens.get(key) ?? (existing ? totalTokens(existing.tokens) + existing.agents.reduce((n, a) => n + totalTokens(a.tokens), 0) : total);
    const delta = Math.max(0, total - prevTotal);
    this.lastTokens.set(key, total);

    // Write only what changed: agents whose content differs from the last write, new events,
    // and the open question only when it changes. Samples and device last-seen are batched.
    const sigs = this.agentSigs(key);
    const changedAgents = rec.agents.filter((a) => sigs.get(a.id) !== JSON.stringify(a));
    const askChanged = (existing?.openAsk?.id ?? null) !== (rec.openAsk?.id ?? null);
    const written = await store.ingestOne(ingestPool, rec, changedAgents, report.events, report.claimDeliveries !== false, report.claimKinds ?? null);
    const fresh = written.freshEventIds;
    if (askChanged) await withTx((c) => this.syncAsk(c, existing, rec, now));
    for (const a of changedAgents) sigs.set(a.id, JSON.stringify(a));
    this.bufferSample(orgId, s.id, now, total, delta, cost, usage, rec.contextUsed, rec.contextWindow);
    await this.touchDevice(device.deviceId, rec.hostname, rec.machineId);

    // Keep ended sessions that already lingered out of the live set.
    const wasGone = existing && !this.get(orgId, s.id) && existing.status === "ended";
    if (!wasGone || rec.status !== "ended") this.orgMap(orgId).set(s.id, rec);

    this.markDirty(rec);
    const freshEvents = report.events.filter((e) => fresh.includes(e.id));
    if (freshEvents.length) {
      let q = this.outEvents.get(orgId);
      if (!q) this.outEvents.set(orgId, (q = []));
      for (const e of freshEvents) q.push(this.eventView(s.id, e));
      if (q.length > 500) q.splice(0, q.length - 500);
    }

    // Notifications and budget checks never hold up the reporter's acknowledgement.
    void this.afterIngest(rec, existing, freshEvents).catch((e) => this.log.error({ err: e, session: rec.id }, "post-ingest checks failed"));

    const deliveries = written.deliveries;
    return {
      ok: true,
      serverTime: now,
      sessionId: s.id,
      ackedEvents: report.events.map((e) => e.id),
      liveSessions: this.liveCount(orgId),
      deliveries,
      reporterSupport: compareMinor(report.reporter.version, config.reporterSupport.min, config.reporterSupport.max),
      // The owner's away setting decides how long the reporter holds a prompt for Tessera.
      presence: (await prefsFor(rec.ownerId).catch(() => null))?.presence ?? "auto",
    };
  }

  private eventView(sessionId: string, e: ActivityEvent): EventView {
    return { id: e.id, sessionId, ts: e.ts, kind: e.kind, agentId: e.agentId, text: e.text };
  }

  /** Record asks as they open and close, so history has every question and its answer. */
  private async syncAsk(c: import("pg").PoolClient, prev: SessionRecord | null | undefined, rec: SessionRecord, now: string): Promise<void> {
    const ask = rec.openAsk;
    if (ask) {
      await c.query(
        `INSERT INTO asks (id, org_id, session_id, kind, tool, prompt, options, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (org_id, session_id, id) DO NOTHING`,
        [ask.id, rec.orgId, rec.id, ask.kind, ask.tool, ask.prompt, JSON.stringify(ask.options), ask.createdAt],
      );
    }
    const prevAsk = prev?.openAsk;
    if (prevAsk && (!ask || ask.id !== prevAsk.id)) {
      await c.query(
        `UPDATE asks SET closed_at = COALESCE(closed_at, $4), outcome = COALESCE(outcome, 'closed_by_session') WHERE org_id = $1 AND session_id = $2 AND id = $3`,
        [rec.orgId, rec.id, prevAsk.id, now],
      );
    }
  }

  private async afterIngest(rec: SessionRecord, prev: SessionRecord | null | undefined, fresh: ActivityEvent[]): Promise<void> {
    const orgId = rec.orgId;
    const label = rec.name ?? rec.git?.repo ?? rec.cwd?.split("/").pop() ?? rec.id.slice(0, 8);
    const owner = rec.control.assignee?.name ?? rec.ownerName ?? "unknown";
    const waitingNow = rec.status === "waiting" && rec.waitReason !== "background" && rec.waitReason !== "idle";
    const waitKey = waitKeyFor(orgId, rec.id, rec.openAsk?.id ?? rec.waitReason ?? "");
    if (waitingNow && !this.waiting.has(waitKey)) {
      const n: Notification = {
        event: "session.waiting",
        dedupeKey: waitKey,
        title: `${label} is waiting on ${owner}`,
        text: waitingText(rec),
        sessionId: rec.id,
        fields: { Owner: rec.ownerName ?? "unknown", ...(rec.control.assignee ? { "Handed to": rec.control.assignee.name } : {}), Model: rec.model ?? "—", Machine: rec.hostname ?? "—", ...(rec.openAsk?.tool ? { Tool: rec.openAsk.tool } : {}), ...waitingFields(rec) },
        ...(rec.openAsk ? { ask: { id: rec.openAsk.id, kind: rec.openAsk.kind } } : {}),
      };
      this.waiting.set(waitKey, { orgId, sessionId: rec.id, since: Date.now(), n });
      await notify(orgId, n, this.log, { waitedMs: 0 });
      if (!rec.openAsk?.inTerminal) {
        const ask = rec.openAsk;
        const answerable = ask && ask.kind !== "question" && !ask.inTerminal;
        await this.pushPersonal(rec, "waiting", `wait:${waitKey}`, {
          kind: "waiting",
          title: `${label} needs ${rec.control.assignee ? rec.control.assignee.name : "you"}`,
          body: pushText(rec),
          tag: `tessera-${rec.id}`,
          url: `/app/sessions/${encodeURIComponent(rec.id)}`,
          sessionId: rec.id,
          ...(answerable ? { ask: { id: ask.id, kind: ask.kind } } : {}),
        });
      }
    }
    // Not answered from Tessera in time: the prompt is now the terminal's. Say so where people were asked.
    if (rec.openAsk?.inTerminal && prev?.openAsk?.id === rec.openAsk.id && !prev.openAsk.inTerminal) {
      const where = rec.hostname ? ` on ${rec.hostname}` : "";
      await resolveNotifications(orgId, waitKey, `Not answered here in time: it is now waiting in the terminal${where}. Answer it there.`, this.log);
      await this.pushPersonal(rec, "waiting", `terminal:${waitKey}`, {
        kind: "waiting",
        title: `${label} is waiting in the terminal`,
        body: `Not answered in Tessera in time. It is now waiting${where}; answer it there.`,
        tag: `tessera-${rec.id}`,
        url: `/app/sessions/${encodeURIComponent(rec.id)}`,
        sessionId: rec.id,
      });
    }
    // Anything this session was waiting on that it no longer is: close it out in chat and paging tools.
    for (const [k, w] of this.waiting) {
      if (w.orgId !== orgId || w.sessionId !== rec.id || (waitingNow && k === waitKey)) continue;
      this.waiting.delete(k);
      await resolveNotifications(orgId, k, rec.status === "ended" ? "The session ended." : "Answered in the terminal, or the session moved on.", this.log);
    }
    // The wait may have started on another replica: close it from the previous state too.
    const prevKey = prev?.status === "waiting" ? waitKeyFor(orgId, rec.id, prev.openAsk?.id ?? prev.waitReason ?? "") : null;
    if (prevKey && !(waitingNow && prevKey === waitKey)) {
      await resolveNotifications(orgId, prevKey, rec.status === "ended" ? "The session ended." : "Answered in the terminal, or the session moved on.", this.log);
    }

    for (const e of fresh) {
      if (e.kind === "turn.end") await this.pushDone(rec, label, e);
      if (e.kind === "agent.fail") {
        const agent = rec.agents.find((a) => a.id === e.agentId);
        await this.pushPersonal(rec, "failed", `fail:${orgId}:${rec.id}:${e.id}`, {
          kind: "failed",
          title: `An agent failed in ${label}`,
          body: (agent?.failure?.summary ?? e.text).slice(0, 300),
          tag: `tessera-fail-${rec.id}`,
          url: `/app/sessions/${encodeURIComponent(rec.id)}`,
          sessionId: rec.id,
        });
        await notify(orgId, {
          event: "agent.failed",
          dedupeKey: `${orgId}:${rec.id}:${e.id}`,
          title: `Agent failed in ${label}`,
          text: agent?.failure?.summary ?? e.text,
          sessionId: rec.id,
          fields: { Owner: owner, Agent: agent?.type ?? e.agentId ?? "—", Class: agent?.failure?.class ?? "unknown" },
        }, this.log);
      } else if (e.kind === "context.blowout") {
        await notify(orgId, {
          event: "context.blowout",
          dedupeKey: `${orgId}:${rec.id}:${e.id}`,
          title: `Context window exceeded in ${label}`,
          text: e.text,
          sessionId: rec.id,
          fields: { Owner: owner, Blowouts: String(rec.blowouts) },
        }, this.log);
      }
    }

    // Budgets: notify once per breach; enforcement is applied by `decide`.
    const statuses = applicable(await budgetStatuses(orgId), rec);
    for (const b of statuses) {
      if (b.level !== "ok" && (await recordBreach(b))) {
        await notify(orgId, {
          event: "budget.breach",
          dedupeKey: `${b.id}:${b.level}:${b.windowStart}`,
          title: `${b.level === "hard" ? "Hard" : "Soft"} budget reached (${b.scopeType}, ${b.window})`,
          text: `$${b.spentUsd.toFixed(2)} spent against a ${b.level} limit of $${(b.level === "hard" ? b.hardUsd : b.softUsd)?.toFixed(2)}${b.enforce && b.level === "hard" ? ". New tool calls are being denied." : "."}`,
          sessionId: rec.id,
        }, this.log);
      }
    }
  }

  /**
   * Push to the session's owner (and whoever it is handed to), if they want this
   * kind and are not at their desk. Sent once across replicas: the push log key
   * goes in first, and only the replica that wrote it sends.
   */
  private async pushPersonal(rec: SessionRecord, want: "waiting" | "done" | "failed", key: string, payload: PushPayload): Promise<void> {
    const people = [...new Set([rec.ownerId, rec.control.assignee?.id].filter((x): x is string => !!x))];
    const targets: string[] = [];
    for (const id of people) {
      const prefs = await prefsFor(id);
      // At the desk, the terminal is right there: no pushes. Handed-over sessions still reach the person they were handed to.
      if (prefs.notify[want] && (prefs.presence !== "desk" || id === rec.control.assignee?.id)) targets.push(id);
    }
    if (!targets.length) return;
    const first = await pool.query("INSERT INTO push_log (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key", [key.slice(0, 400)]);
    if (!first.rowCount) return;
    await pushTo(targets, payload, this.log);
  }

  /** A turn that ran for a while has ended: tell the owner what came of it. */
  private async pushDone(rec: SessionRecord, label: string, end: ActivityEvent): Promise<void> {
    const r = await pool.query<{ started: string | null }>(
      "SELECT MAX(ts) AS started FROM events WHERE org_id = $1 AND session_id = $2 AND kind = 'turn.start' AND ts <= $3",
      [rec.orgId, rec.id, end.ts],
    );
    const started = r.rows[0]?.started ? Date.parse(r.rows[0].started) : null;
    const took = started ? Date.parse(end.ts) - started : 0;
    // Short turns are back-and-forth with someone at the keyboard; only long ones are worth a notification.
    if (took < 90_000) return;
    const cost = priceFor(totalUsage(rec.usageByModel, rec.agents), await priceTableFor(rec.orgId)).usd;
    const files = rec.filesChanged ?? [];
    const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
    const failed = rec.agents.filter((a) => a.status === "failed").length;
    const parts = [
      `Finished after ${Math.round(took / 60_000)} min`,
      files.length ? `${files.length} file${files.length > 1 ? "s" : ""} changed (+${added} −${removed})` : "no files changed",
      cost !== null ? `$${cost.toFixed(2)} so far` : null,
      failed ? `${failed} agent${failed > 1 ? "s" : ""} failed` : null,
    ].filter(Boolean);
    await this.pushPersonal(rec, "done", `done:${rec.orgId}:${rec.id}:${end.id}`, {
      kind: "done",
      title: `${label} is done`,
      body: parts.join(" · "),
      tag: `tessera-${rec.id}`,
      url: `/app/sessions/${encodeURIComponent(rec.id)}`,
      sessionId: rec.id,
    });
  }

  /**
   * Decision for a tool call, in order: a paused session denies everything, a
   * hard budget with enforcement denies, then the organisation's policy rules.
   */
  async decide(device: DevicePrincipal, req: DecideRequest): Promise<DecideResponse> {
    const orgId = device.orgId;
    const rec = this.get(orgId, req.sessionId);
    if (rec?.control.stop) {
      // One-shot: refuse this call and tell Claude Code to stop the turn, then clear the request.
      const stop = rec.control.stop;
      rec.control = { ...rec.control, stop: null };
      await store.setControl(orgId, rec.id, rec.control);
      this.markDirty(rec);
      return { decision: "deny", stop: true, reason: `Stopped from Tessera by ${stop.by}${stop.reason ? `: ${stop.reason}` : "."} Wait for the engineer before continuing.` };
    }
    if (rec?.control.paused) return { decision: "deny", reason: `Session paused in Tessera${rec.control.reason ? `: ${rec.control.reason}` : ""}` };
    const scope = rec ?? (await store.loadSession(orgId, req.sessionId));
    if (scope) {
      const hard = applicable(await budgetStatuses(orgId), scope).find((b) => b.level === "hard" && b.enforce);
      if (hard) return { decision: "deny", reason: `Tessera budget exceeded (${hard.scopeType}, ${hard.window}): $${hard.spentUsd.toFixed(2)} of $${hard.hardUsd?.toFixed(2)}. Tool ${req.tool} refused.` };
    }
    const policy = await activePolicy(orgId);
    if (!policy.doc.rules.length) return { decision: "allow", reason: null };
    const call = callFrom(req, scope ? { cwd: scope.cwd, model: scope.model, git: scope.git, teamId: scope.teamId ?? device.teamId } : { cwd: null, model: null, git: null, teamId: device.teamId });
    const verdict = evaluatePolicy(policy.doc, call);
    if (verdict.dryRun.length || (verdict.rule && verdict.rule.effect !== "allow")) {
      void recordDecisions(orgId, req.sessionId, device.userId, call, verdict, policy.version).catch((e) => this.log.error({ err: e }, "policy decision record failed"));
    }
    const rule = verdict.rule;
    if (!rule) return { decision: "allow", reason: null };
    // An explicit allow rule lets the runtime skip its own permission prompt.
    if (rule.effect === "allow") return { decision: "allow", reason: `Allowed by Tessera policy "${rule.name}"`, explicit: true };
    const reason = `${rule.effect === "deny" ? "Denied" : "Needs approval"} by Tessera policy "${rule.name}"${rule.reason ? `: ${rule.reason}` : "."}`;
    if (rule.effect === "deny" && scope) {
      const label = scope.name ?? scope.git?.repo ?? req.sessionId.slice(0, 8);
      void notify(orgId, {
        event: "policy.denied",
        dedupeKey: `${orgId}:${req.sessionId}:policy:${rule.id}:${Math.floor(Date.now() / 600_000)}`,
        title: `Policy "${rule.name}" denied a tool call in ${label}`,
        text: summaryOf(call),
        sessionId: req.sessionId,
        fields: { Owner: scope.ownerName ?? device.userName, Rule: rule.name, ...(rule.reason ? { Reason: rule.reason } : {}) },
        severity: "warning",
      }, this.log).catch((e) => this.log.error({ err: e }, "policy notification failed"));
    }
    return { decision: rule.effect, reason };
  }

  // ---- deliveries ------------------------------------------------------

  private async takeDeliveries(orgId: string, sessionId: string, kinds: DeliveryKind[] | null): Promise<ReportAck["deliveries"]> {
    const r = await pool.query<{ id: string; kind: DeliveryKind; ask_id: string | null; payload: Record<string, unknown> }>(
      `UPDATE deliveries SET delivered_at = now() WHERE id IN (
         SELECT id FROM deliveries WHERE org_id = $1 AND session_id = $2 AND delivered_at IS NULL AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
         ORDER BY created_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, ask_id, payload`,
      [orgId, sessionId, kinds],
    );
    return r.rows.map((d) => ({ id: d.id, kind: d.kind, askId: d.ask_id, payload: d.payload }));
  }

  /**
   * Deliveries the reporter can pull while it waits on a prompt. The mod asks
   * for messages only, so it never takes an answer a waiting hook needs.
   */
  async pendingDeliveries(orgId: string, sessionId: string, kinds: DeliveryKind[] | null = null): Promise<ReportAck["deliveries"]> {
    return this.takeDeliveries(orgId, sessionId, kinds);
  }

  async queueDelivery(orgId: string, sessionId: string, kind: DeliveryKind, askId: string | null, payload: Record<string, unknown>, userId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      "INSERT INTO deliveries (org_id, session_id, kind, ask_id, payload, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [orgId, sessionId, kind, askId, JSON.stringify(payload), userId],
    );
    if (askId) {
      await pool.query(
        "UPDATE asks SET answered_by = $4, answer = $5, closed_at = now(), outcome = 'answered' WHERE org_id = $1 AND session_id = $2 AND id = $3",
        [orgId, sessionId, askId, userId, JSON.stringify(payload)],
      );
    }
    return r.rows[0]!.id;
  }

  /** Does this session belong to the device's person (or is it unknown yet)? Other machines may not read or answer for it. */
  async ownedBy(device: DevicePrincipal, sessionId: string): Promise<boolean> {
    const rec = this.get(device.orgId, sessionId) ?? (await store.loadSession(device.orgId, sessionId));
    return !rec || rec.ownerId === device.userId;
  }

  async deliveryResult(orgId: string, userId: string, id: string, result: Record<string, unknown>): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const r = await pool.query(
      `UPDATE deliveries d SET result = $4, result_at = now() FROM sessions s
        WHERE d.org_id = $1 AND d.id = $2 AND s.org_id = d.org_id AND s.id = d.session_id AND s.owner_id = $3`,
      [orgId, id, userId, JSON.stringify(result)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---- control ---------------------------------------------------------

  async setPaused(orgId: string, sessionId: string, paused: boolean, reason: string | null, by: string): Promise<SessionRecord | null> {
    const rec = this.get(orgId, sessionId);
    if (!rec) return null;
    rec.control = { ...rec.control, paused, reason: paused ? reason : null, by: paused ? by : null };
    await store.setControl(orgId, sessionId, rec.control);
    this.markDirty(rec);
    return rec;
  }

  /** Ask the session to stop at its next tool call. */
  async requestStop(orgId: string, sessionId: string, by: string, reason: string | null): Promise<SessionRecord | null> {
    const rec = this.get(orgId, sessionId);
    if (!rec) return null;
    rec.control = { ...rec.control, stop: { by, reason, at: new Date().toISOString() } };
    await store.setControl(orgId, sessionId, rec.control);
    this.markDirty(rec);
    return rec;
  }

  /** Hand the session to someone else (or back, with null). */
  async assign(orgId: string, sessionId: string, assignee: { id: string; name: string } | null, by: string): Promise<SessionRecord | null> {
    const rec = this.get(orgId, sessionId);
    if (!rec) return null;
    rec.control = { ...rec.control, assignee: assignee ? { ...assignee, by, at: new Date().toISOString() } : null };
    await store.setControl(orgId, sessionId, rec.control);
    this.markDirty(rec);
    return rec;
  }

  /** Take a person's sessions off the wall (their data was erased). */
  forgetOwner(orgId: string, userId: string): void {
    for (const rec of [...this.orgMap(orgId).values()]) if (rec.ownerId === userId) this.remove(orgId, rec.id);
  }

  async drop(orgId: string, sessionId: string): Promise<boolean> {
    const rec = this.get(orgId, sessionId);
    if (!rec) return false;
    const now = new Date().toISOString();
    rec.droppedAt = now;
    await store.markDropped(orgId, sessionId, now);
    this.remove(orgId, sessionId);
    return true;
  }

  // ---- broadcasting ----------------------------------------------------

  private markDirty(rec: SessionRecord): void {
    this.hub.replicate({ op: "set", orgId: rec.orgId, rec });
    let set = this.dirty.get(rec.orgId);
    if (!set) this.dirty.set(rec.orgId, (set = new Set()));
    set.add(rec.id);
  }

  /** Send every changed session and new event for each org as one batch. */
  private async flushStream(): Promise<void> {
    const orgs = new Set([...this.dirty.keys(), ...this.outEvents.keys()]);
    for (const orgId of orgs) {
      const ids = this.dirty.get(orgId);
      this.dirty.delete(orgId);
      const events = this.outEvents.get(orgId);
      this.outEvents.delete(orgId);
      if (!this.hub.hasClients(orgId)) continue;
      if (ids?.size) {
        const table = await priceTableFor(orgId);
        const now = Date.now();
        const views: SessionView[] = [];
        for (const id of ids) {
          const rec = this.get(orgId, id);
          if (rec) views.push(deriveSession(rec, table, now, config.staleAfterMs));
        }
        if (views.length) this.hub.broadcast(orgId, { type: "sessions", data: views });
      }
      if (events?.length) this.hub.broadcast(orgId, { type: "events", data: events });
    }
  }

  private agentSigs(key: string): Map<string, string> {
    let m = this.agentSig.get(key);
    if (!m) this.agentSig.set(key, (m = new Map()));
    return m;
  }

  private bufferSample(orgId: string, sessionId: string, at: string, total: number, delta: number, cost: number | null, usage: SessionRecord["usageByModel"], contextUsed: number | null, contextWindow: number | null): void {
    const minute = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000).toISOString();
    const k = `${orgId}|${sessionId}|${minute}`;
    const prev = this.samples.get(k);
    // The minute's fullest point: a compaction inside the minute must not hide how close it came.
    const used = Math.max(prev?.contextUsed ?? 0, contextUsed ?? 0) || null;
    this.samples.set(k, { orgId, sessionId, minute, tokensTotal: total, tokensDelta: (prev?.tokensDelta ?? 0) + delta, costUsd: cost, usage, contextUsed: used, contextWindow: contextWindow ?? prev?.contextWindow ?? null });
  }

  private async flushSamples(): Promise<void> {
    if (!this.samples.size) return;
    const rows = [...this.samples.values()];
    this.samples.clear();
    for (let i = 0; i < rows.length; i += 1000) await store.flushSamples(pool, rows.slice(i, i + 1000));
  }

  private async touchDevice(deviceId: string, hostname: string | null, machineId: string | null): Promise<void> {
    const last = this.deviceSeen.get(deviceId) ?? 0;
    if (Date.now() - last < DEVICE_TOUCH_MS) return;
    this.deviceSeen.set(deviceId, Date.now());
    await pool.query("UPDATE devices SET last_seen_at = now(), hostname = $2, machine_id = $3 WHERE id = $1", [deviceId, hostname, machineId]);
  }

  private remove(orgId: string, id: string): void {
    for (const [k, w] of this.waiting) {
      if (w.orgId === orgId && w.sessionId === id) {
        this.waiting.delete(k);
        void resolveNotifications(orgId, k, "The session left the wall.", this.log).catch(() => {});
      }
    }
    this.orgMap(orgId).delete(id);
    this.lastTokens.delete(`${orgId}:${id}`);
    this.agentSig.delete(`${orgId}:${id}`);
    this.dirty.get(orgId)?.delete(id);
    this.hub.broadcast(orgId, { type: "removed", data: { id } });
    this.hub.replicate({ op: "remove", orgId, id });
  }

  // ---- time ------------------------------------------------------------

  private async sweep(): Promise<void> {
    const now = Date.now();
    const delayed = new Map<string, boolean>();
    for (const w of this.waiting.values()) {
      let has = delayed.get(w.orgId);
      if (has === undefined) delayed.set(w.orgId, (has = await hasDelayedChannels(w.orgId)));
      if (has) await notify(w.orgId, w.n, this.log, { waitedMs: now - w.since });
    }
    for (const [orgId, m] of this.live) {
      for (const rec of [...m.values()]) {
        const seen = Date.parse(rec.lastSeenAt);
        if (rec.status === "ended") {
          if (now - Date.parse(rec.endedAt ?? rec.lastSeenAt) > config.lingerMs) this.remove(orgId, rec.id);
          continue;
        }
        const staleFor = now - seen - config.staleAfterMs;
        if (staleFor > config.dropAfterMs) {
          rec.droppedAt = new Date(now).toISOString();
          await store.markDropped(orgId, rec.id, rec.droppedAt);
          this.remove(orgId, rec.id);
          this.log.info({ orgId, session: rec.id }, "fleet: session dropped");
        } else if (staleFor >= 0 && staleFor < 1500) {
          // Just crossed into stale: push the change once.
          this.markDirty(rec);
          await notify(orgId, {
            event: "session.stale",
            dedupeKey: `${orgId}:${rec.id}:stale:${Math.floor(seen / 1000)}`,
            title: `${rec.name ?? rec.git?.repo ?? rec.id.slice(0, 8)} went silent`,
            text: `No report for ${Math.round(config.staleAfterMs / 1000)} s from ${rec.hostname ?? "its machine"}.`,
            sessionId: rec.id,
          }, this.log);
        }
      }
    }
  }

  private async tick(): Promise<void> {
    for (const orgId of this.hub.orgsWithClients()) {
      const views = await this.views(orgId);
      const kpis = await computeKpis(orgId, views);
      this.hub.broadcast(orgId, { type: "kpis", data: kpis });
      this.hub.broadcast(orgId, { type: "tick", data: { serverTime: new Date().toISOString() } });
    }
  }
}
