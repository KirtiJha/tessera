import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { principalFromRequest } from "./auth/session.js";
import { config } from "./config.js";
import { Fleet } from "./fleet/fleet.js";
import { StreamHub } from "./fleet/stream.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { enrolRoutes } from "./routes/enrol.js";
import { fleetRoutes } from "./routes/fleet.js";
import { ingestRoutes } from "./routes/ingest.js";
import { ssoAdminRoutes, ssoRoutes } from "./routes/sso.js";
import { metrics, metricsRoutes } from "./metrics.js";

export interface App {
  server: FastifyInstance;
  fleet: Fleet;
  hub: StreamHub;
}

export async function buildApp(): Promise<App> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.logFormat === "text" && !config.isProd ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } } : {}),
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-tessera-token']"],
    },
    trustProxy: config.isProd,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: config.logLevel !== "debug",
  });

  await server.register(cookie, { secret: config.secret });
  await server.register(rateLimit, { global: true, max: 1200, timeWindow: "1 minute" });

  // Security headers on every response.
  server.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.isProd) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  // Host check: refuse names the server does not expect (DNS rebinding).
  server.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    const ok =
      name === "localhost" || name === "127.0.0.1" || name === "[::1]" || host === config.publicHost.toLowerCase() || name === config.publicHost.toLowerCase().replace(/:\d+$/, "") || config.allowedHosts.some((h) => h.toLowerCase() === name || h.toLowerCase() === host);
    if (!ok && config.isProd) {
      reply.code(403).send({ error: "host not allowed" });
      return reply;
    }
  });

  server.decorateRequest("principal", null);
  server.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/ingest") && !req.url.startsWith("/api/enrol")) {
      req.principal = await principalFromRequest(req);
    }
  });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}` });
    }
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal error" : e.message });
  });

  const hub = new StreamHub(server.log);
  const fleet = new Fleet(hub, server.log);

  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(ssoRoutes, { prefix: "/api/auth/sso" });
  await server.register(ssoAdminRoutes, { prefix: "/api/admin/sso" });
  await server.register(enrolRoutes, { prefix: "/api/enrol" });
  await server.register(ingestRoutes, { prefix: "/api/ingest", fleet });
  await server.register(fleetRoutes, { prefix: "/api/fleet", fleet, hub });
  await server.register(adminRoutes, { prefix: "/api/admin" });

  await server.register(metricsRoutes);
  metrics.liveSessions = () => fleet.totalLive();
  metrics.streamClients = () => hub.clientCount();
  server.get("/api/health", async () => ({ ok: true, version: "0.1.0", time: new Date().toISOString() }));
  server.get("/api/*", async (_req, reply) => reply.code(404).send({ error: "not found" }));

  // The reporter, served by the server itself so machines install the version that matches it.
  const reporterTgz = config.reporterTgz || join(process.cwd(), "..", "..", "packages", "reporter-claude", "release", "tessera-reporter.tgz");
  server.get("/downloads/tessera-reporter.tgz", async (_req, reply) => {
    if (!existsSync(reporterTgz)) return reply.code(404).send({ error: "reporter package not built on this server" });
    reply.header("content-type", "application/gzip");
    reply.header("cache-control", "no-cache");
    reply.header("content-disposition", 'attachment; filename="tessera-reporter.tgz"');
    return reply.send(createReadStream(reporterTgz));
  });

  const dist = config.webDist || join(process.cwd(), "..", "web", "dist");
  if (existsSync(join(dist, "index.html"))) {
    await server.register(fastifyStatic, { root: dist, wildcard: false, maxAge: "1h", immutable: false, setHeaders: (res, path) => {
      if (/\/assets\//.test(path)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
    } });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
    server.log.info({ dist }, "serving web app");
  } else {
    server.log.warn({ dist }, "web app build not found; API only (run the web dev server or build it)");
  }

  return { server, fleet, hub };
}
