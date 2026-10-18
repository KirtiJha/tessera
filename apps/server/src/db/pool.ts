import pg from "pg";
import { config } from "../config.js";

const { Pool, types } = pg;

// numeric → number, bigint → number (values stay far below 2^53 here), timestamptz → ISO string
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Reporter writes get their own pool, so a burst of reports can never starve
 * the console's queries, and run with synchronous_commit off: a report is a
 * full snapshot the reporter re-sends, so losing the last fraction of a second
 * of writes on a database crash costs nothing that the next report does not
 * restore, and it removes a WAL flush from every report.
 */
export const ingestPool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.INGEST_POOL_SIZE ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  options: "-c synchronous_commit=off",
});
ingestPool.on("error", (err) => console.error("pg ingest pool error", err.message));

pool.on("error", (err) => {
  // A client in the pool errored while idle; the next checkout will make a new one.
  console.error("pg pool error", err.message);
});

export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    c.release();
  }
}
