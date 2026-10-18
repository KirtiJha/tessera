import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { issueDevice } from "../auth/devices.js";
import { pool } from "../db/pool.js";

/** Unauthenticated: a reporter exchanges a one-time enrolment code for a device token. */
export async function enrolRoutes(app: FastifyInstance): Promise<void> {
  app.post("/exchange", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().toUpperCase().max(20), label: z.string().trim().min(1).max(120), hostname: z.string().max(120).optional() }).parse(req.body);
    const r = await pool.query<{ org_id: string; user_id: string; name: string }>(
      `SELECT e.org_id, e.user_id, u.name FROM enrolment_codes e JOIN users u ON u.id = e.user_id
        WHERE e.code = $1 AND e.used_at IS NULL AND e.expires_at > now() AND u.status = 'active'`,
      [body.code],
    );
    const row = r.rows[0];
    if (!row) {
      await new Promise((res) => setTimeout(res, 300));
      return reply.code(404).send({ error: "That enrolment code is not valid or has expired." });
    }
    const { id, token } = await issueDevice(row.org_id, row.user_id, body.label);
    await pool.query("UPDATE enrolment_codes SET used_at = now(), device_id = $2 WHERE code = $1", [body.code, id]);
    if (body.hostname) await pool.query("UPDATE devices SET hostname = $2 WHERE id = $1", [id, body.hostname.slice(0, 120)]);
    await audit({ orgId: row.org_id, actorId: row.user_id, actorName: row.name, action: "device.enrol", targetType: "device", targetId: id, detail: { label: body.label }, ip: req.ip });
    return { ok: true, token, user: row.name };
  });
}
