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
