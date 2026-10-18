import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { principalFromApiKey, scopeFor } from "./auth/apikeys.js";
import { sha256 } from "./auth/crypto.js";
import { principalFromRequest } from "./auth/session.js";
import { config } from "./config.js";
import { Fleet } from "./fleet/fleet.js";
import { StreamHub } from "./fleet/stream.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { enrolRoutes } from "./routes/enrol.js";
import { fleetRoutes } from "./routes/fleet.js";
import { ingestRoutes } from "./routes/ingest.js";
import { integrationRoutes } from "./routes/integrations.js";
import { policyRoutes } from "./routes/policy.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { apiKeyRoutes } from "./routes/apikeys.js";
import { scimRoutes } from "./routes/scim.js";
import { dataRoutes } from "./routes/data.js";
import { openapi } from "./openapi.js";
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
    // The versioned public API is the console's own API under a stable prefix.
    rewriteUrl: (req) => (req.url?.startsWith("/api/v1/") ? `/api/${req.url.slice(8)}` : (req.url ?? "/")),
  });

  await server.register(cookie, { secret: config.secret });
  await server.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
    // API keys are limited per key, so one busy integration cannot use up an office's shared address.
    keyGenerator: (req) => {
      const a = req.headers.authorization;
      return a?.startsWith("Bearer tsk_") ? `key:${sha256(a.slice(7).trim())}` : req.ip;
    },
  });

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
    // Health checks come from load balancers and the kubelet by address, not by name; they carry no data.
    if (!ok && config.isProd && req.url !== "/api/health") {
      reply.code(403).send({ error: "host not allowed" });
      return reply;
    }
  });

  server.decorateRequest("principal", null);
  server.decorateRequest("apiKey", null);
  server.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/ingest") || req.url.startsWith("/api/enrol")) return;
    if (req.headers.authorization?.startsWith("Bearer tsk_")) {
      const k = await principalFromApiKey(req);
      if (!k) return reply.code(401).send({ error: "API key missing, revoked, expired, or its owner is disabled" });
      const need = scopeFor(req.method, req.url);
      if (!need) return reply.code(403).send({ error: "API keys cannot call this endpoint" });
      if (need !== "any" && !k.key.scopes.includes(need)) return reply.code(403).send({ error: `This API key lacks the ${need} scope` });
      req.principal = k.p;
      req.apiKey = k.key;
      return;
    }
    req.principal = await principalFromRequest(req);
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
  await server.register(analyticsRoutes, { prefix: "/api/analytics" });
  await server.register(apiKeyRoutes, { prefix: "/api/keys" });
  await server.register(scimRoutes, { prefix: "/scim/v2" });
  await server.register(dataRoutes, { prefix: "/api/admin/data", fleet });
  server.get("/api/openapi.json", async () => openapi());
  await server.register(policyRoutes, { prefix: "/api/admin/policy" });
  await server.register(integrationRoutes, { prefix: "/api/integrations", fleet });

  await server.register(metricsRoutes);
  metrics.liveSessions = () => fleet.totalLive();
  metrics.streamClients = () => hub.clientCount();
  server.get("/api/health", async () => ({ ok: true, version: "0.1.0", time: new Date().toISOString() }));
  server.get("/api/*", async (_req, reply) => reply.code(404).send({ error: "not found" }));

  // The reporter and the CLI, served by the server itself so machines install the version that matches it.
  const pkgs = join(process.cwd(), "..", "..", "packages");
  const downloads: Record<string, string> = {
    "tessera-reporter.tgz": config.reporterTgz || join(pkgs, "reporter-claude", "release", "tessera-reporter.tgz"),
    "tessera-cli.tgz": config.cliTgz || join(pkgs, "cli", "release", "tessera-cli.tgz"),
  };
  server.get("/downloads/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const path = downloads[file];
    if (!path) return reply.code(404).send({ error: "not found" });
    if (!existsSync(path)) return reply.code(404).send({ error: `${file} is not built on this server` });
    reply.header("content-type", "application/gzip");
    reply.header("cache-control", "no-cache");
    reply.header("content-disposition", `attachment; filename="${file}"`);
    return reply.send(createReadStream(path));
  });

  const dist = config.webDist || join(process.cwd(), "..", "web", "dist");
  if (existsSync(join(dist, "index.html"))) {
    await server.register(fastifyStatic, { root: dist, wildcard: false, maxAge: "1h", immutable: false, setHeaders: (res, path) => {
      if (/\/assets\//.test(path)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
    } });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/scim/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
    server.log.info({ dist }, "serving web app");
  } else {
    server.log.warn({ dist }, "web app build not found; API only (run the web dev server or build it)");
  }

  return { server, fleet, hub };
}
