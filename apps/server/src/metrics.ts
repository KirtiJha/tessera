import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { ingestPool, pool } from "./db/pool.js";
import { safeEqual } from "./auth/crypto.js";

/**
 * Prometheus metrics at GET /api/metrics. Served only to loopback addresses,
 * or to anyone presenting `Authorization: Bearer $METRICS_TOKEN` when that is set.
 */

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

/** Fixed-bucket histogram in milliseconds, plus a ring of recent values for quantiles. */
class Histogram {
  private counts: number[];
  private sum = 0;
  private n = 0;
  private ring: number[] = [];
  private ringAt = 0;
  constructor(private bounds: number[], private ringSize = 5000) {
    this.counts = Array(bounds.length + 1).fill(0);
  }
  observe(ms: number): void {
    let i = this.bounds.findIndex((b) => ms <= b);
    if (i < 0) i = this.bounds.length;
    this.counts[i]!++;
    this.sum += ms;
    this.n++;
    if (this.ring.length < this.ringSize) this.ring.push(ms);
    else this.ring[this.ringAt++ % this.ringSize] = ms;
  }
  quantile(q: number): number {
    if (!this.ring.length) return 0;
    const s = [...this.ring].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
  render(name: string, help: string): string {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    let acc = 0;
    this.bounds.forEach((b, i) => {
      acc += this.counts[i]!;
      lines.push(`${name}_bucket{le="${b / 1000}"} ${acc}`);
    });
    acc += this.counts[this.bounds.length]!;
    lines.push(`${name}_bucket{le="+Inf"} ${acc}`, `${name}_sum ${this.sum / 1000}`, `${name}_count ${this.n}`);
    return lines.join("\n");
  }
}

const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const metrics = {
  ingest: new Histogram(BOUNDS),
  reports: 0,
  reportErrors: 0,
  streamClients: () => 0,
  liveSessions: () => 0,
};

export function snapshotMetrics() {
  return {
    eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    ingestMs: { p50: metrics.ingest.quantile(0.5), p95: metrics.ingest.quantile(0.95), p99: metrics.ingest.quantile(0.99) },
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    ingestPool: { total: ingestPool.totalCount, idle: ingestPool.idleCount, waiting: ingestPool.waitingCount },
    reports: metrics.reports,
    reportErrors: metrics.reportErrors,
  };
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metrics", { config: { rateLimit: false } }, async (req, reply) => {
    const token = process.env.METRICS_TOKEN ?? "";
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const loopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!(token ? safeEqual(auth, token) : loopback)) return reply.code(403).send({ error: "metrics are served to loopback or with METRICS_TOKEN" });
    if ((req.query as { format?: string }).format === "json") return snapshotMetrics();
    const mem = process.memoryUsage();
    const body = [
      metrics.ingest.render("tessera_ingest_duration_seconds", "Time to handle one report."),
      "# TYPE tessera_reports_total counter",
      `tessera_reports_total ${metrics.reports}`,
      "# TYPE tessera_report_errors_total counter",
      `tessera_report_errors_total ${metrics.reportErrors}`,
      "# TYPE tessera_live_sessions gauge",
      `tessera_live_sessions ${metrics.liveSessions()}`,
      "# TYPE tessera_stream_clients gauge",
      `tessera_stream_clients ${metrics.streamClients()}`,
      "# TYPE tessera_event_loop_delay_seconds gauge",
      `tessera_event_loop_delay_seconds{quantile="0.5"} ${loop.percentile(50) / 1e9}`,
      `tessera_event_loop_delay_seconds{quantile="0.99"} ${loop.percentile(99) / 1e9}`,
      "# TYPE tessera_pg_pool_connections gauge",
      `tessera_pg_pool_connections{state="total"} ${pool.totalCount}`,
      `tessera_pg_pool_connections{state="idle"} ${pool.idleCount}`,
      `tessera_pg_pool_connections{state="waiting"} ${pool.waitingCount}`,
      `tessera_pg_ingest_pool_connections{state="total"} ${ingestPool.totalCount}`,
      `tessera_pg_ingest_pool_connections{state="idle"} ${ingestPool.idleCount}`,
      `tessera_pg_ingest_pool_connections{state="waiting"} ${ingestPool.waitingCount}`,
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      "",
    ].join("\n");
    reply.header("content-type", "text/plain; version=0.0.4");
    void config;
    return body;
  });
}
