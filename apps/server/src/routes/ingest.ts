import { DecideRequest, DiffUpload, parseReport, Presence } from "@tessera/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sha256 } from "../auth/crypto.js";
import { z } from "zod";
import { deviceFromRequest } from "../auth/devices.js";
import { audit } from "../audit.js";
import { prefsFor, savePrefs } from "../notify/personal.js";
import { dataSettingsFor } from "../fleet/datasettings.js";
import { receiveDiff } from "../fleet/diffs.js";
import type { Fleet } from "../fleet/fleet.js";
import { metrics } from "../metrics.js";
import { foldTraces, OtlpSession, type OtlpTraces } from "../fleet/otlp.js";
import { createGunzip } from "node:zlib";

/**
 * Rate limits for reporter routes are per device token, never per IP: a whole
 * office often reaches the server from one address, and an IP limit would lock
 * out every engineer there once a handful are working. A request without a
 * token falls back to its IP (and is refused by the auth hook anyway).
 */
export function perDevice(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest) => {
        const auth = req.headers.authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : (req.headers["x-tessera-token"] as string | undefined);
        return token ? `dev:${sha256(token)}` : `ip:${req.ip}`;
      },
    },
  };
}

/** Routes reporters call. Every one needs a device token. */
export async function ingestRoutes(app: FastifyInstance, opts: { fleet: Fleet }): Promise<void> {
  const { fleet } = opts;

  // Accept protobuf bodies only to answer them with a useful hint.
  app.addContentTypeParser("application/x-protobuf", { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  // OTLP exporters may gzip their bodies.
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers["content-encoding"] === "gzip") {
      delete req.headers["content-encoding"];
      delete req.headers["content-length"];
      return payload.pipe(createGunzip());
    }
    return payload;
  });

  app.addHook("preHandler", async (req, reply) => {
    const device = await deviceFromRequest(req);
    if (!device) {
      reply.code(401).send({ error: "device token missing, revoked or unknown" });
      return reply;
    }
    (req as typeof req & { device: typeof device }).device = device;
  });

  app.post("/report", { bodyLimit: 2 * 1024 * 1024, config: perDevice(3000) }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const t0 = performance.now();
    metrics.reports++;
    const parsed = parseReport(req.body);
    if (!parsed.ok) {
      metrics.reportErrors++;
      req.log.info({ device: device.deviceId, err: parsed.error }, "report rejected");
      return reply.code(400).send({ error: parsed.error });
    }
    try {
      const ack = await fleet.ingest(parsed.report, device, req.ip);
      metrics.ingest.observe(performance.now() - t0);
      return ack;
    } catch (e) {
      metrics.reportErrors++;
      const err = e as Error & { statusCode?: number };
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      throw e;
    }
  });

  /**
   * OpenTelemetry traces (OTLP/HTTP, JSON encoding) from any agent runtime that
   * follows the GenAI semantic conventions. Point the runtime's exporter at
   * <server>/api/ingest/otlp/v1/traces with the device token as a header.
   */
  const otlpSessions = new Map<string, OtlpSession>();
  const otlpDevices = new Map<string, NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>>>();
  // Spans arrive only when they finish, so a long model call would look silent.
  // Keep each OTLP session alive while it has been active in the last five
  // minutes, then end it.
  const keepAlive = setInterval(() => {
    void (async () => {
      for (const [k, s] of otlpSessions) {
        const device = otlpDevices.get(k);
        if (!device) continue;
        const idle = Date.now() - Date.parse(s.lastAt);
        if (idle > 5 * 60_000) s.ended = true;
        const parsed = parseReport(s.report());
        if (parsed.ok) await fleet.ingest(parsed.report, device, undefined).catch(() => {});
        if (s.ended) {
          otlpSessions.delete(k);
          otlpDevices.delete(k);
        }
      }
    })();
  }, 10_000);
  keepAlive.unref();
  app.addHook("onClose", async () => clearInterval(keepAlive));

  app.post("/otlp/v1/traces", { bodyLimit: 8 * 1024 * 1024, config: perDevice(1200) }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    if (!String(req.headers["content-type"] ?? "").includes("json")) {
      return reply.code(415).send({ error: "Send OTLP as JSON: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (protobuf is not accepted)." });
    }
    const byOrg = new Map<string, OtlpSession>();
    for (const [k, v] of otlpSessions) if (k.startsWith(`${device.orgId}:`)) byOrg.set(k.slice(device.orgId.length + 1), v);
    const folded = foldTraces((req.body ?? {}) as OtlpTraces, byOrg);
    let rejected = folded.rejected;
    const problems: string[] = [];
    for (const s of folded.touched) {
      otlpSessions.set(`${device.orgId}:${s.id}`, s);
      otlpDevices.set(`${device.orgId}:${s.id}`, device);
      const parsed = parseReport(s.report());
      if (!parsed.ok) {
        problems.push(parsed.error);
        continue;
      }
      try {
        await fleet.ingest(parsed.report, device, req.ip);
        metrics.reports++;
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        if (!err.statusCode) throw e;
        problems.push(`${s.id}: ${err.message}`);
        rejected++;
      }
    }
    // OTLP's partial-success response: the exporter logs it and does not retry.
    return { partialSuccess: rejected || problems.length ? { rejectedSpans: rejected, errorMessage: problems.slice(0, 3).join("; ") || "too many spans in one request" } : {} };
  });

  /** Policy decision before a tool call. The reporter's PreToolUse hook asks and obeys. */
  app.post("/decide", { config: perDevice(3000) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const body = DecideRequest.parse(req.body);
    // Only the device's own person's sessions: a stop or decision must not be consumed by someone else's machine.
    if (!(await fleet.ownedBy(device, body.sessionId))) return { decision: "allow", reason: null };
    return fleet.decide(device, body);
  });

  /**
   * Long-poll for deliveries while the reporter waits on a prompt. `kinds`
   * (comma separated) claims only those kinds and leaves the rest queued.
   */
  app.get("/sessions/:id/deliveries", { config: perDevice(600) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    const q = z.object({ wait: z.coerce.number().min(0).max(25).default(0), kinds: z.string().max(60).optional() }).parse(req.query);
    const kinds = q.kinds ? z.array(z.enum(["answer", "message", "command"])).min(1).parse(q.kinds.split(",")) : null;
    const deadline = Date.now() + q.wait * 1000;
    if (!(await fleet.ownedBy(device, id))) return { deliveries: [], serverTime: new Date().toISOString() };
    for (;;) {
      const d = await fleet.pendingDeliveries(device.orgId, id, kinds);
      if (d.length || Date.now() >= deadline) return { deliveries: d, serverTime: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  /** The uncommitted diff a person asked for, already redacted on the machine. */
  app.post("/sessions/:id/diff", { bodyLimit: 1024 * 1024, config: perDevice(60) }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    if (!(await fleet.ownedBy(device, id))) return reply.code(403).send({ error: "this session belongs to another person" });
    const body = DiffUpload.parse(req.body);
    const ok = receiveDiff(device.orgId, id, body, (await dataSettingsFor(device.orgId)).dlp);
    return ok ? { ok: true } : reply.code(409).send({ error: "nobody asked for this diff, or it was asked for again" });
  });

  app.post("/deliveries/:id/result", { config: perDevice(600) }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    const body = z.object({ result: z.record(z.unknown()) }).parse(req.body);
    const ok = await fleet.deliveryResult(device.orgId, device.userId, id, body.result);
    return ok ? { ok: true } : reply.code(404).send({ error: "no such delivery" });
  });

  app.get("/whoami", { config: perDevice(60) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const prefs = await prefsFor(device.userId);
    return { device: device.label, user: device.userName, liveSessions: fleet.liveCount(device.orgId), presence: prefs.presence };
  });

  /** Away mode from the terminal (the mod's /tessera away): the same setting as the console's, for the device's person. */
  app.put("/presence", { config: perDevice(60) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const body = z.object({ presence: Presence }).parse(req.body);
    const before = await prefsFor(device.userId);
    const prefs = await savePrefs(device.userId, { presence: body.presence });
    if (body.presence !== before.presence) {
      await audit({ orgId: device.orgId, actorId: device.userId, actorName: device.userName, action: "user.presence", targetType: "user", targetId: device.userId, detail: { from: before.presence, to: body.presence, via: "terminal", device: device.label }, ip: req.ip });
    }
    return { presence: prefs.presence };
  });
}
