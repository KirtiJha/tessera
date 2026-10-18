import { buildApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { ingestPool, pool } from "./db/pool.js";

const { server, fleet, hub } = await buildApp();

try {
  await migrate(pool, (m) => server.log.info(m));
  await bootstrap(server.log);
  await hub.start();
  await fleet.start();
  await server.listen({ port: config.port, host: config.host, backlog: 2048 });
  server.log.info({ url: config.publicUrl, env: config.env }, "tessera is up");
} catch (e) {
  server.log.error({ err: e }, "startup failed");
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, "shutting down");
  await fleet.stop();
  await hub.stop();
  await server.close();
  await ingestPool.end();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
