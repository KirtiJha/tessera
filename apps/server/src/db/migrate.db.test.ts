/**
 * Two processes migrating a brand-new database at the same moment (replicas
 * starting together) must both succeed, and each migration must run once.
 * Needs a PostgreSQL role that can create databases; skipped otherwise.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";

const base = process.env.DATABASE_URL ?? "";
let canCreate = false;
if (base) {
  const admin = new pg.Client({ connectionString: base });
  try {
    await admin.connect();
    const r = await admin.query<{ ok: boolean }>("SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user");
    canCreate = !!r.rows[0]?.ok;
  } catch {
    canCreate = false;
  } finally {
    await admin.end().catch(() => {});
  }
}

describe.skipIf(!canCreate)("migrate", () => {
  it("serialises concurrent runs on a fresh database", async () => {
    const name = `tessera_migrate_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const a = new pg.Pool({ connectionString: url.toString(), max: 2 });
    const b = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      // Every migration ran exactly once, in one of the two processes.
      const all = [...ra, ...rb].sort();
      expect(new Set(all).size).toBe(all.length);
      const n = await a.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM schema_migrations");
      expect(n.rows[0]!.n).toBe(all.length);
      expect(all.length).toBeGreaterThan(0);
      // And a later start has nothing left to do.
      expect(await migrate(a)).toEqual([]);
    } finally {
      await a.end();
      await b.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
});
