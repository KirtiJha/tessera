import { pool } from "./pool.js";
import { migrate } from "./migrate.js";

const done = await migrate(pool, (m) => console.log(m));
console.log(done.length ? `applied ${done.length} migration(s)` : "database is up to date");
await pool.end();
