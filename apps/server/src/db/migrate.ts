import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const dir = join(here, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const done: string[] = [];
  const client = await pool.connect();
  try {
    // Serialise migrations across replicas starting at once.
    await client.query("SELECT pg_advisory_lock(7342001)");
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
    await client.query("SELECT pg_advisory_unlock(7342001)");
  } finally {
    client.release();
  }
  return done;
}
