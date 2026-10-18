import { parseReport } from "@tessera/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sha256 } from "../auth/crypto.js";
import { z } from "zod";
import { deviceFromRequest } from "../auth/devices.js";
import type { Fleet } from "../fleet/fleet.js";
import { metrics } from "../metrics.js";

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

  /** Policy decision before a tool call. The reporter's PreToolUse hook asks and obeys. */
  app.post("/decide", { config: perDevice(3000) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const body = z.object({ sessionId: z.string().max(128), tool: z.string().max(120) }).parse(req.body);
    return fleet.decide(device.orgId, body.sessionId, body.tool);
  });

  /** Long-poll for deliveries while the reporter waits on a prompt. */
  app.get("/sessions/:id/deliveries", { config: perDevice(600) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    const waitMs = Math.min(25_000, Math.max(0, Number((req.query as { wait?: string }).wait ?? 0) * 1000));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const d = await fleet.pendingDeliveries(device.orgId, id);
      if (d.length || Date.now() >= deadline) return { deliveries: d, serverTime: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  app.post("/deliveries/:id/result", { config: perDevice(600) }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    const body = z.object({ result: z.record(z.unknown()) }).parse(req.body);
    const ok = await fleet.deliveryResult(device.orgId, id, body.result);
    return ok ? { ok: true } : reply.code(404).send({ error: "no such delivery" });
  });

  app.get("/whoami", { config: perDevice(60) }, async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    return { device: device.label, user: device.userName, liveSessions: fleet.liveCount(device.orgId) };
  });
}
