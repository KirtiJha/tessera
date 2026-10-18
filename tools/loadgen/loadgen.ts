/**
 * Tessera load generator.
 *
 * Simulates N Claude Code sessions reporting to a Tessera server through the
 * real ingest API, with evolving token counts, agents, events and occasional
 * waits. A second connection subscribes to the console stream the way a
 * browser does and measures how long a report takes to reach it.
 *
 *   pnpm --filter @tessera/loadgen start -- --server http://localhost:4700 \
 *     --email owner@acme.test --password '…' --sessions 500 --duration 60
 *
 * Options: --interval <ms> between reports per session (default 1000),
 * --agents <n> per session (default 4), --keep to leave sessions live at the
 * end (for looking at the wall), --json to print the summary as JSON.
 */
import type { Report, SessionView, StreamMessage } from "@tessera/contract";
import { monitorEventLoopDelay } from "node:perf_hooks";
import http from "node:http";
import https from "node:https";
import { createGunzip } from "node:zlib";

const args = process.argv.slice(2);
const opt = (name: string, def?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined && def === undefined) throw new Error(`--${name} is required`);
  return v ?? def!;
};
const flag = (name: string) => args.includes(`--${name}`);

const SERVER = opt("server", "http://localhost:4700").replace(/\/+$/, "");
const EMAIL = opt("email");
const PASSWORD = opt("password");
const SESSIONS = Number(opt("sessions", "100"));
const DURATION_S = Number(opt("duration", "60"));
const INTERVAL_MS = Number(opt("interval", "1000"));
const AGENTS = Number(opt("agents", "4"));
const KEEP = flag("keep");
const JSON_OUT = flag("json");
const RUN = Date.now().toString(36);

// ---- stats ---------------------------------------------------------------
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function summary(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? NaN };
}

// ---- auth ------------------------------------------------------------------
async function signIn(): Promise<string> {
  const res = await fetch(`${SERVER}/api/auth/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tessera-client": "web" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return cookie;
}

async function issueDevice(cookie: string, n: number): Promise<string> {
  const res = await fetch(`${SERVER}/api/admin/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tessera-client": "web", cookie },
    body: JSON.stringify({ label: `loadgen-${RUN}-${n}` }),
  });
  if (!res.ok) throw new Error(`device issue failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function revokeDevices(cookie: string): Promise<void> {
  const list = (await (await fetch(`${SERVER}/api/admin/devices`, { headers: { cookie } })).json()) as { devices: { id: string; label: string; revokedAt: string | null }[] };
  for (const d of list.devices) if (d.label.startsWith(`loadgen-${RUN}-`) && !d.revokedAt) {
    await fetch(`${SERVER}/api/admin/devices/${d.id}/revoke`, { method: "POST", headers: { "content-type": "application/json", "x-tessera-client": "web", cookie }, body: "{}" });
  }
}

/** Sessions per simulated machine: each machine has its own device token, as in a real fleet. */
const PER_MACHINE = 5;

// ---- simulated session -----------------------------------------------------
const REPOS = ["payments-api", "web-console", "ingest-edge", "billing-worker", "mobile-app", "infra-terraform", "search-service", "auth-gateway"];
const MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Glob", "Write"];

class SimSession {
  id: string;
  started = new Date().toISOString();
  seq = 0;
  tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  model: string;
  repo: string;
  agents: Report["session"]["agents"] = [];
  pending: Report["events"] = [];
  status: Report["session"]["status"] = "running";
  ended = false;

  constructor(public n: number) {
    this.id = `lg-${RUN}-${n}`;
    this.model = MODELS[n % MODELS.length]!;
    this.repo = REPOS[n % REPOS.length]!;
  }

  private event(kind: Report["events"][number]["kind"], text: string, agentId: string | null = null) {
    this.seq++;
    this.pending.push({ id: `${this.seq}`, ts: new Date().toISOString(), kind, agentId, text });
  }

  step(): Report {
    const r = Math.random();
    this.tokens.input += 200 + Math.floor(r * 2000);
    this.tokens.output += 50 + Math.floor(r * 400);
    this.tokens.cacheRead += 5000 + Math.floor(r * 20000);
    if (this.agents.filter((a) => a.status === "running").length < AGENTS && r < 0.15) {
      const id = `a${this.seq}`;
      this.agents.push({
        id, parentId: null, kind: "subagent", type: r < 0.08 ? "Explore" : "general-purpose", description: `Investigate ${this.repo} module ${this.seq}`,
        model: "claude-haiku-4-5", effort: "low", status: "running", startedAt: new Date().toISOString(), endedAt: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageByModel: [], context: null, toolCalls: {}, skills: [], failure: null, promptExcerpt: null, answerExcerpt: null,
      });
      this.event("agent.spawn", `spawned agent ${id}`, id);
    }
    for (const a of this.agents) {
      if (a.status !== "running") continue;
      a.tokens.input += 300;
      a.tokens.output += 60;
      a.usageByModel = [{ model: "claude-haiku-4-5", ...a.tokens }];
      const t = TOOLS[Math.floor(Math.random() * TOOLS.length)]!;
      a.toolCalls[t] = (a.toolCalls[t] ?? 0) + 1;
      if (Math.random() < 0.05) {
        a.status = Math.random() < 0.15 ? "failed" : "done";
        a.endedAt = new Date().toISOString();
        if (a.status === "failed") a.failure = { class: "tool_error", at: a.endedAt, tool: "Bash", summary: "Bash(pnpm test): exit 1", exitCode: 1, outputTail: ["FAIL src/x.test.ts"] };
        this.event(a.status === "failed" ? "agent.fail" : "agent.done", `${a.type} ${a.status}`, a.id);
      }
    }
    // Keep the agent list bounded like a real long session (finished agents stay, but cap growth).
    if (this.agents.length > 40) this.agents.splice(0, this.agents.length - 40);
    this.status = Math.random() < 0.02 ? "waiting" : this.status === "waiting" && Math.random() < 0.7 ? "waiting" : "running";
    if (this.status === "running" && Math.random() < 0.5) this.event("turn.start", `tool ${TOOLS[this.seq % TOOLS.length]}`);
    return this.report();
  }

  report(): Report {
    const sentAt = Date.now();
    return {
      v: 1,
      sentAt: new Date(sentAt).toISOString(),
      reporter: { kind: "custom", version: "0.1.0", schema: "1.0" },
      machine: { hostname: `lg-host-${Math.floor(this.n / PER_MACHINE)}`, machineId: `lg${Math.floor(this.n / PER_MACHINE)}` },
      session: {
        id: this.id,
        name: `${this.repo}: task ${this.n}`,
        cwd: `/home/dev/${this.repo}`,
        model: this.model,
        effort: "medium",
        status: this.ended ? "ended" : this.status,
        waitReason: this.status === "waiting" ? "permission" : null,
        startedAt: this.started,
        endedAt: this.ended ? new Date().toISOString() : null,
        endReason: this.ended ? "loadgen" : null,
        context: { used: Math.min(190_000, 20_000 + this.seq * 900), window: 200_000 },
        tokens: { ...this.tokens },
        usageByModel: [{ model: this.model, ...this.tokens }],
        ledgerCostUsd: null,
        blowouts: 0,
        git: { repo: `acme/${this.repo}`, branch: `feat/lg-${this.n}`, worktree: null, ahead: 1, behind: 0, modified: 3 },
        filesChanged: [],
        plan: { title: null, source: "TaskCreate", steps: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, title: `Step ${i}`, status: i <= (this.seq % 5) ? "completed" : "pending", ownerAgentId: null })) },
        agents: this.agents,
        openAsk: this.status === "waiting" ? { id: `ask-${this.seq}`, kind: "permission", createdAt: new Date().toISOString(), tool: "Bash", prompt: "Bash(pnpm test)", options: [] } : null,
        tags: { lg_t: String(sentAt) },
        continuedFrom: null,
      },
      events: this.pending.slice(),
    };
  }
}

// ---- stream client ---------------------------------------------------------
interface StreamStats { latencies: number[]; messages: number; bytes: number; sessionsSeen: Set<string>; encoding: string }

async function streamClient(cookie: string, stats: StreamStats, stop: AbortSignal): Promise<void> {
  // node:http rather than fetch, so the byte count is what crosses the wire (compressed), as a browser receives it.
  const url = new URL(`${SERVER}/api/fleet/stream`);
  const lastSeen = new Map<string, number>();
  const onSession = (s: SessionView) => {
    if (!s.id.startsWith(`lg-${RUN}-`)) return;
    stats.sessionsSeen.add(s.id);
    const t = Number(s.tags.lg_t);
    if (!t || (lastSeen.get(s.id) ?? 0) >= t) return;
    lastSeen.set(s.id, t);
    stats.latencies.push(Date.now() - t);
  };
  await new Promise<void>((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(url, { headers: { cookie, accept: "text/event-stream", "accept-encoding": "gzip" } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream failed: ${res.statusCode}`));
      stats.encoding = res.headers["content-encoding"] ?? "identity";
      res.on("data", (c: Buffer) => (stats.bytes += c.byteLength));
      const body = stats.encoding === "gzip" ? res.pipe(createGunzip()) : res;
      body.setEncoding("utf8");
      let buf = "";
      body.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          stats.messages++;
          const msg = { type, data: JSON.parse(data) } as StreamMessage;
          if (msg.type === "sessions") for (const s of msg.data) onSession(s);
        }
      });
      body.on("end", () => resolve());
      body.on("error", () => resolve());
    });
    req.on("error", (e) => (stop.aborted ? resolve() : reject(e)));
    stop.addEventListener("abort", () => {
      req.destroy();
      resolve();
    });
  });
}

// ---- main ------------------------------------------------------------------
async function main() {
  const cookie = await signIn();
  const tokens: string[] = [];
  for (let m = 0; m < Math.ceil(SESSIONS / PER_MACHINE); m++) tokens.push(await issueDevice(cookie, m));
  const sims = Array.from({ length: SESSIONS }, (_, i) => new SimSession(i));
  const ingest: number[] = [];
  const errors = new Map<string, number>();
  let sent = 0;

  const stopStream = new AbortController();
  const stream: StreamStats = { latencies: [], messages: 0, bytes: 0, sessionsSeen: new Set(), encoding: "?" };
  const streamDone = streamClient(cookie, stream, stopStream.signal).catch((e) => console.error("stream error:", (e as Error).message));

  const post = async (sim: SimSession, report: Report) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${SERVER}/api/ingest/report`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens[Math.floor(sim.n / PER_MACHINE)]}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(10_000),
      });
      const ms = performance.now() - t0;
      if (res.ok) {
        const ack = (await res.json()) as { ackedEvents: string[] };
        const acked = new Set(ack.ackedEvents);
        sim.pending = sim.pending.filter((e) => !acked.has(e.id));
        ingest.push(ms);
      } else {
        errors.set(String(res.status), (errors.get(String(res.status)) ?? 0) + 1);
        await res.text();
      }
    } catch (e) {
      const k = (e as Error).name === "TimeoutError" ? "timeout" : "network";
      errors.set(k, (errors.get(k) ?? 0) + 1);
    }
    sent++;
  };

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const startedAt = Date.now();
  const endAt = startedAt + DURATION_S * 1000;
  process.stderr.write(`loadgen ${RUN}: ${SESSIONS} sessions × 1 report / ${INTERVAL_MS} ms for ${DURATION_S} s against ${SERVER}\n`);

  // Each session runs its own loop with a random phase so reports spread evenly.
  const loops = sims.map(async (sim) => {
    await new Promise((r) => setTimeout(r, Math.random() * INTERVAL_MS));
    while (Date.now() < endAt) {
      const t = Date.now();
      await post(sim, sim.step());
      const wait = INTERVAL_MS - (Date.now() - t);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait * (0.9 + Math.random() * 0.2)));
    }
  });
  const progress = setInterval(() => {
    const el = (Date.now() - startedAt) / 1000;
    process.stderr.write(`  ${el.toFixed(0)} s: ${sent} reports (${(sent / el).toFixed(0)}/s), ${[...errors.values()].reduce((a, b) => a + b, 0)} errors, stream ${stream.messages} msgs\n`);
  }, 10_000);
  await Promise.all(loops);
  clearInterval(progress);
  const elapsed = (Date.now() - startedAt) / 1000;

  // Let the last updates arrive before stopping the stream.
  await new Promise((r) => setTimeout(r, 2000));
  stopStream.abort();
  await streamDone;

  if (!KEEP) {
    await Promise.all(sims.map((s) => { s.ended = true; return post(s, s.report()); }));
    await revokeDevices(cookie);
  }

  const result = {
    run: RUN,
    sessions: SESSIONS,
    durationS: Math.round(elapsed),
    reportsPerSecond: Math.round(sent / elapsed),
    targetReportsPerSecond: Math.round((SESSIONS * 1000) / INTERVAL_MS),
    errors: Object.fromEntries(errors),
    ingestMs: Object.fromEntries(Object.entries(summary(ingest)).map(([k, v]) => [k, Math.round(v)])),
    wallLatencyMs: Object.fromEntries(Object.entries(summary(stream.latencies)).map(([k, v]) => [k, Math.round(v)])),
    loadgenEventLoopDelayMs: { p99: Math.round(loopDelay.percentile(99) / 1e6), max: Math.round(loopDelay.max / 1e6) },
    stream: { encoding: stream.encoding, sessionsSeen: stream.sessionsSeen.size, messagesPerSecond: Math.round(stream.messages / elapsed), kilobytesPerSecond: Math.round(stream.bytes / 1024 / elapsed) },
  };
  if (JSON_OUT) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    console.log(`\nresult (${result.durationS} s, ${SESSIONS} sessions)`);
    console.log(`  reports/s         ${result.reportsPerSecond} of ${result.targetReportsPerSecond} target`);
    console.log(`  errors            ${JSON.stringify(result.errors)}`);
    console.log(`  ingest ms         p50 ${result.ingestMs.p50}  p95 ${result.ingestMs.p95}  p99 ${result.ingestMs.p99}  max ${result.ingestMs.max}`);
    console.log(`  report→wall ms    p50 ${result.wallLatencyMs.p50}  p95 ${result.wallLatencyMs.p95}  p99 ${result.wallLatencyMs.p99}  max ${result.wallLatencyMs.max}  (n=${result.wallLatencyMs.n})`);
    console.log(`  loadgen loop lag  p99 ${result.loadgenEventLoopDelayMs.p99}  max ${result.loadgenEventLoopDelayMs.max} (the generator's own stalls; ingest times include them)`);
    console.log(`  stream            ${result.stream.messagesPerSecond} msg/s, ${result.stream.kilobytesPerSecond} KB/s on the wire (${result.stream.encoding}), ${result.stream.sessionsSeen} sessions seen`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
