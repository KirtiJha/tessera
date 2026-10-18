import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const LOCK_ID = 7342001;

/**
 * Apply pending migrations in order. Safe to run from several processes at
 * once (replicas starting together): everything, including reading which
 * migrations are already applied, happens while holding one advisory lock,
 * so a process that waited for the lock sees what the first one applied.
 */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const dir = join(here, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      for (const f of files) {
        if (applied.has(f)) continue;
        const sql = await readFile(join(dir, f), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${f} failed: ${(e as Error).message}`);
        }
        log(`applied ${f}`);
        done.push(f);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
  return done;
}
