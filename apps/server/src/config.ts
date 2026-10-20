import { randomBytes } from "node:crypto";

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return n;
}

const env = process.env.NODE_ENV ?? "development";
const isProd = env === "production";

let secret = process.env.SECRET_KEY ?? "";
if (!secret || secret === "change-me-to-a-long-random-string") {
  if (isProd) throw new Error("SECRET_KEY must be set to a long random value in production");
  secret = randomBytes(32).toString("hex");
}
if (secret.length < 32) throw new Error("SECRET_KEY must be at least 32 characters");

// On Render the service's own address is known without configuration.
const platformUrl = process.env.RENDER_EXTERNAL_URL ?? (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : undefined);
const publicUrl = (process.env.PUBLIC_URL || platformUrl || `http://localhost:${int("PORT", 4700)}`).replace(/\/+$/, "");

export const config = {
  env,
  isProd,
  port: int("PORT", 4700),
  host: process.env.HOST ?? "0.0.0.0",
  publicUrl,
  publicHost: new URL(publicUrl).host,
  allowedHosts: (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  secret,
  bootstrap: {
    orgName: process.env.BOOTSTRAP_ORG_NAME ?? "",
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "",
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
  },
  staleAfterMs: int("STALE_AFTER_MS", 15_000),
  dropAfterMs: int("DROP_AFTER_MS", 60_000),
  lingerMs: int("LINGER_MS", 8_000),
  retainSamplesDays: int("RETAIN_SAMPLES_DAYS", 30),
  retainEventsDays: int("RETAIN_EVENTS_DAYS", 180),
  retainSessionsDays: int("RETAIN_SESSIONS_DAYS", 365),
  logFormat: process.env.LOG_FORMAT === "json" ? "json" : "text",
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** Reporter versions this server reads correctly (major.minor compared). */
  reporterSupport: { min: "0.1", max: "0.1" },
  webDist: process.env.WEB_DIST ?? "",
  reporterTgz: process.env.REPORTER_TGZ ?? "",
  cliTgz: process.env.CLI_TGZ ?? "",
  /** Overridable for tests and for proxies that front these APIs. */
  slackApiUrl: (process.env.SLACK_API_URL ?? "https://slack.com/api").replace(/\/+$/, ""),
  pagerdutyEventsUrl: process.env.PAGERDUTY_EVENTS_URL ?? "https://events.pagerduty.com/v2/enqueue",
  /**
   * "Explain this failure": a key for the Claude API (a secret: set it in the
   * platform's secret store), the model, and the endpoint (overridable for a
   * gateway or for tests). Without a key the feature stays off.
   */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicApiUrl: (process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""),
  explainModel: process.env.EXPLAIN_MODEL ?? "claude-haiku-5-5",
  /** Most explanations one organisation can ask for in an hour. */
  explainPerHour: int("EXPLAIN_PER_HOUR", 60),
} as const;

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
