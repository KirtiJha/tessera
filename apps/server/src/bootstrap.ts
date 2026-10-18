import type { FastifyBaseLogger } from "fastify";
import { audit } from "./audit.js";
import { hashPassword } from "./auth/crypto.js";
import { config } from "./config.js";
import { pool, withTx } from "./db/pool.js";

/** Create the first organisation and owner from BOOTSTRAP_* when the database is empty. */
export async function bootstrap(log: FastifyBaseLogger): Promise<void> {
  const b = config.bootstrap;
  if (!b.orgName || !b.adminEmail || !b.adminPassword) return;
  const any = await pool.query("SELECT 1 FROM orgs LIMIT 1");
  if (any.rowCount) return;
  if (b.adminPassword.length < 10) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters");
  const hash = await hashPassword(b.adminPassword);
  await withTx(async (c) => {
    const slug = b.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
    const org = await c.query<{ id: string }>("INSERT INTO orgs (name, slug) VALUES ($1,$2) RETURNING id", [b.orgName, slug]);
    const u = await c.query<{ id: string }>(
      "INSERT INTO users (org_id, email, name, password_hash, role, status) VALUES ($1,$2,$3,$4,'owner','active') RETURNING id",
      [org.rows[0]!.id, b.adminEmail.toLowerCase(), "Owner", hash],
    );
    await audit({ orgId: org.rows[0]!.id, actorId: u.rows[0]!.id, actorName: "bootstrap", action: "org.bootstrap", targetType: "org", targetId: org.rows[0]!.id, detail: { email: b.adminEmail } }, c);
  });
  log.info({ org: b.orgName, email: b.adminEmail }, "bootstrap: first organisation created");
}
