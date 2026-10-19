import { Presence } from "@tessera/contract";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { checkMutation, requireUser } from "../auth/session.js";
import { prefsFor, pushTo, savePrefs, subscribe, subscriptionCount, unsubscribe, vapidKeys } from "../notify/personal.js";

/** The signed-in person's own settings: away mode, personal notifications, and this device's push subscription. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    checkMutation(req);
    await requireUser(req, reply);
  });

  app.get("/preferences", async (req) => {
    const p = req.principal!;
    const prefs = await prefsFor(p.userId);
    return { ...prefs, pushDevices: await subscriptionCount(p.userId), pushKey: (await vapidKeys()).publicKey };
  });

  app.put("/preferences", async (req) => {
    const p = req.principal!;
    const body = z
      .object({
        presence: Presence.optional(),
        notify: z.object({ waiting: z.boolean().optional(), done: z.boolean().optional(), failed: z.boolean().optional() }).optional(),
      })
      .parse(req.body);
    const before = await prefsFor(p.userId);
    const prefs = await savePrefs(p.userId, body);
    if (body.presence && body.presence !== before.presence) {
      await audit({ orgId: p.orgId, actorId: p.userId, actorName: p.name, action: "user.presence", targetType: "user", targetId: p.userId, detail: { from: before.presence, to: body.presence }, ip: req.ip });
    }
    return prefs;
  });

  app.post("/push", async (req) => {
    const p = req.principal!;
    const body = z
      .object({
        endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "push endpoints are https"),
        keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(8).max(100) }),
        label: z.string().trim().max(120).optional(),
      })
      .parse(req.body);
    await subscribe(p.userId, body, body.label ?? ((req.headers["user-agent"] ?? "").slice(0, 120) || null));
    return { ok: true, pushDevices: await subscriptionCount(p.userId) };
  });

  app.post("/push/remove", async (req) => {
    const p = req.principal!;
    const body = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
    await unsubscribe(p.userId, body.endpoint);
    return { ok: true, pushDevices: await subscriptionCount(p.userId) };
  });

  app.post("/push/test", async (req) => {
    const p = req.principal!;
    const sent = await pushTo([p.userId], { kind: "test", title: "Tessera notifications work", body: "Prompts waiting on you, and finished or failed sessions, will show up like this.", tag: "tessera-test", url: "/app" }, req.log);
    return { ok: true, sent };
  });
}
