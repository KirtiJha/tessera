import { clean, totalTokens, type DecideRequest, type DecideResponse, type ActivityEvent, type EventView, type FleetSnapshot, type Report, type ReportAck, type SessionView } from "@tessera/contract";
import type { FastifyBaseLogger } from "fastify";
import type { DevicePrincipal } from "../auth/devices.js";
import { config } from "../config.js";
import { ingestPool, pool, withTx } from "../db/pool.js";
import { hasDelayedChannels, notify, resolveNotifications, type Notification } from "../notify/notifier.js";
import { applicable, budgetStatuses, recordBreach } from "./budgets.js";
import { deriveSession } from "./derive.js";
import { computeKpis } from "./kpis.js";
import { activePolicy, callFrom, evaluatePolicy, recordDecisions, summaryOf } from "./policy.js";
import { priceFor, priceTableFor } from "./pricing.js";
import * as store from "./store.js";
import type { StreamHub } from "./stream.js";
import type { SessionRecord } from "./types.js";

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
function sanitise(r: Report): void {
  const s = r.session;
  s.name = s.name && clean(s.name, 200);
  s.cwd = s.cwd && clean(s.cwd, 400);
  if (s.git) {
    s.git.repo = s.git.repo && clean(s.git.repo, 200);
    s.git.branch = s.git.branch && clean(s.git.branch, 200);
    s.git.worktree = s.git.worktree && clean(s.git.worktree, 400);
  }
  for (const f of s.filesChanged) f.path = clean(f.path, 400);
  if (s.plan) {
    s.plan.title = s.plan.title && clean(s.plan.title, 300);
    for (const st of s.plan.steps) st.title = clean(st.title, 300);
  }
  if (s.openAsk) {
    s.openAsk.prompt = clean(s.openAsk.prompt, 4000);
    s.openAsk.options = s.openAsk.options.map((o) => clean(o, 300));
  }
  for (const a of s.agents) {
    a.description = a.description && clean(a.description, 400);
    a.promptExcerpt = a.promptExcerpt && clean(a.promptExcerpt, 400);
    a.answerExcerpt = a.answerExcerpt && clean(a.answerExcerpt, 400);
    if (a.failure) {
      a.failure.summary = clean(a.failure.summary, 500);
      a.failure.outputTail = a.failure.outputTail.map((l) => clean(l, 240));
    }
  }
  for (const e of r.events) e.text = clean(e.text, 500);
  for (const k of Object.keys(s.tags)) s.tags[k] = clean(s.tags[k] ?? "", 200);
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
  ) {}

  async start(): Promise<void> {
    const recs = await store.loadLiveSessions(config.lingerMs);
    for (const r of recs) this.orgMap(r.orgId).set(r.id, r);
    this.log.info({ sessions: recs.length }, "fleet: live set loaded");
    this.timers.push(setInterval(() => void this.sweep().catch((e) => this.log.error({ err: e }, "sweep failed")), 1000));
    this.timers.push(setInterval(() => void this.tick().catch((e) => this.log.error({ err: e }, "tick failed")), 2000));
    this.timers.push(setInterval(() => void this.flushStream().catch((e) => this.log.error({ err: e }, "stream flush failed")), STREAM_FLUSH_MS));
    this.timers.push(setInterval(() => void this.flushSamples().catch((e) => this.log.error({ err: e }, "sample flush failed")), SAMPLE_FLUSH_MS));
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
    sanitise(report);
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
    };
    if (rec.status === "ended" && !rec.endedAt) rec.endedAt = now;
    // A stop that never met a tool call is moot once the turn is over.
    if (rec.control.stop && rec.status !== "running") {
      rec.control = { ...rec.control, stop: null };
      void store.setControl(orgId, rec.id, rec.control).catch(() => {});
    }

    const table = await priceTableFor(orgId);
    const cost = priceFor(rec.usageByModel, table).usd;
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
    const written = await store.ingestOne(ingestPool, rec, changedAgents, report.events);
    const fresh = written.freshEventIds;
    if (askChanged) await withTx((c) => this.syncAsk(c, existing, rec, now));
    for (const a of changedAgents) sigs.set(a.id, JSON.stringify(a));
    this.bufferSample(orgId, s.id, now, total, delta, cost, rec.usageByModel);
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
        text: rec.openAsk ? rec.openAsk.prompt.slice(0, 500) : `Reason: ${rec.waitReason ?? "input"}`,
        sessionId: rec.id,
        fields: { Owner: rec.ownerName ?? "unknown", ...(rec.control.assignee ? { "Handed to": rec.control.assignee.name } : {}), Model: rec.model ?? "—", Machine: rec.hostname ?? "—", ...(rec.openAsk?.tool ? { Tool: rec.openAsk.tool } : {}) },
        ...(rec.openAsk ? { ask: { id: rec.openAsk.id, kind: rec.openAsk.kind } } : {}),
      };
      this.waiting.set(waitKey, { orgId, sessionId: rec.id, since: Date.now(), n });
      await notify(orgId, n, this.log, { waitedMs: 0 });
    }
    // Anything this session was waiting on that it no longer is: close it out in chat and paging tools.
    for (const [k, w] of this.waiting) {
      if (w.orgId !== orgId || w.sessionId !== rec.id || (waitingNow && k === waitKey)) continue;
      this.waiting.delete(k);
      await resolveNotifications(orgId, k, rec.status === "ended" ? "The session ended." : "Answered in the terminal, or the session moved on.", this.log);
    }

    for (const e of fresh) {
      if (e.kind === "agent.fail") {
        const agent = rec.agents.find((a) => a.id === e.agentId);
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
    if (!rule || rule.effect === "allow") return { decision: "allow", reason: null };
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

  private async takeDeliveries(orgId: string, sessionId: string): Promise<ReportAck["deliveries"]> {
    const r = await pool.query<{ id: string; kind: "answer" | "message" | "command"; ask_id: string | null; payload: Record<string, unknown> }>(
      `UPDATE deliveries SET delivered_at = now() WHERE id IN (
         SELECT id FROM deliveries WHERE org_id = $1 AND session_id = $2 AND delivered_at IS NULL ORDER BY created_at ASC LIMIT 20)
       RETURNING id, kind, ask_id, payload`,
      [orgId, sessionId],
    );
    return r.rows.map((d) => ({ id: d.id, kind: d.kind, askId: d.ask_id, payload: d.payload }));
  }

  /** Deliveries the reporter can pull while it waits on a permission prompt. */
  async pendingDeliveries(orgId: string, sessionId: string): Promise<ReportAck["deliveries"]> {
    return this.takeDeliveries(orgId, sessionId);
  }

  async queueDelivery(orgId: string, sessionId: string, kind: "answer" | "message" | "command", askId: string | null, payload: Record<string, unknown>, userId: string): Promise<string> {
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

  async deliveryResult(orgId: string, id: string, result: Record<string, unknown>): Promise<boolean> {
    const r = await pool.query("UPDATE deliveries SET result = $3, result_at = now() WHERE org_id = $1 AND id = $2", [orgId, id, JSON.stringify(result)]);
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

  private bufferSample(orgId: string, sessionId: string, at: string, total: number, delta: number, cost: number | null, usage: SessionRecord["usageByModel"]): void {
    const minute = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000).toISOString();
    const k = `${orgId}|${sessionId}|${minute}`;
    const prev = this.samples.get(k);
    this.samples.set(k, { orgId, sessionId, minute, tokensTotal: total, tokensDelta: (prev?.tokensDelta ?? 0) + delta, costUsd: cost, usage });
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
