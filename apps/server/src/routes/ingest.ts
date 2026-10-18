import { parseReport } from "@tessera/contract";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deviceFromRequest } from "../auth/devices.js";
import type { Fleet } from "../fleet/fleet.js";

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

  app.post("/report", { bodyLimit: 2 * 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const parsed = parseReport(req.body);
    if (!parsed.ok) {
      req.log.info({ device: device.deviceId, err: parsed.error }, "report rejected");
      return reply.code(400).send({ error: parsed.error });
    }
    try {
      return await fleet.ingest(parsed.report, device, req.ip);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      throw e;
    }
  });

  /** Policy decision before a tool call. The reporter's PreToolUse hook asks and obeys. */
  app.post("/decide", async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const body = z.object({ sessionId: z.string().max(128), tool: z.string().max(120) }).parse(req.body);
    return fleet.decide(device.orgId, body.sessionId, body.tool);
  });

  /** Long-poll for deliveries while the reporter waits on a prompt. */
  app.get("/sessions/:id/deliveries", async (req) => {
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

  app.post("/deliveries/:id/result", async (req, reply) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    const { id } = req.params as { id: string };
    const body = z.object({ result: z.record(z.unknown()) }).parse(req.body);
    const ok = await fleet.deliveryResult(device.orgId, id, body.result);
    return ok ? { ok: true } : reply.code(404).send({ error: "no such delivery" });
  });

  app.get("/whoami", async (req) => {
    const device = (req as typeof req & { device: NonNullable<Awaited<ReturnType<typeof deviceFromRequest>>> }).device;
    return { device: device.label, user: device.userName, liveSessions: fleet.liveCount(device.orgId) };
  });
}
