import { clean, type ActivityEvent, type AgentReport, type ModelUsage, type Report, type ReporterInfo } from "@tessera/contract";

/**
 * OpenTelemetry ingest: any agent runtime that exports traces with the GenAI
 * semantic conventions appears on the wall, with no Tessera code on the machine.
 *
 *  - a session is the value of `tessera.session.id`, `session.id` or
 *    `gen_ai.conversation.id` (else the trace id);
 *  - `gen_ai.operation.name = invoke_agent` spans are agents, nested by span parentage;
 *  - `chat` / `text_completion` spans carry `gen_ai.usage.*` tokens per model;
 *  - `execute_tool` spans count tool calls, and an error status is a failed tool call.
 *
 * Exporters send finished spans in batches, children before their parents, so
 * the state per session is accumulated here and turned into the same snapshot
 * a first-party reporter sends; ingest then treats it like any other report.
 */

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: AnyValue[] } };
type KeyValue = { key: string; value?: AnyValue };
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number | string; message?: string };
}
export interface OtlpTraces {
  resourceSpans?: { resource?: { attributes?: KeyValue[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

function val(v: AnyValue | undefined): string | number | boolean | null {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(val).join(",");
  return null;
}
const attrs = (kv: KeyValue[] | undefined): Record<string, string | number | boolean | null> => Object.fromEntries((kv ?? []).map((a) => [a.key, val(a.value)]));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const iso = (nano: string | number | undefined): string | null => {
  if (nano === undefined || nano === "0" || nano === 0) return null;
  const ms = Number(BigInt(String(nano)) / 1_000_000n);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};
const isError = (s: OtlpSpan) => s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR";

/** Which first-party kind a runtime looks like, from service.name or gen_ai.system. */
function kindOf(service: string | null, system: string | null): ReporterInfo["kind"] {
  const s = `${service ?? ""} ${system ?? ""}`.toLowerCase();
  if (s.includes("codex")) return "codex-cli";
  if (s.includes("gemini")) return "gemini-cli";
  if (s.includes("cursor")) return "cursor";
  return "custom";
}

interface Contribution {
  parent: string | null;
  model: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  tool: string | null;
}

interface AgentSpan {
  id: string;
  parent: string | null;
  type: string | null;
  description: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  failed: boolean;
  failure: string | null;
}

/** Everything known about one session from its spans so far. */
export class OtlpSession {
  kind: ReporterInfo["kind"] = "custom";
  version = "otlp";
  name: string | null = null;
  cwd: string | null = null;
  repo: string | null = null;
  branch: string | null = null;
  model: string | null = null;
  startedAt: string;
  lastAt: string;
  ended = false;
  hostname = "otlp";
  machineId = "otlp";
  private parents = new Map<string, string | null>();
  private contributions = new Map<string, Contribution>();
  private agents = new Map<string, AgentSpan>();
  private outbox: ActivityEvent[] = [];
  private seen = new Set<string>();

  constructor(
    readonly id: string,
    at: string,
  ) {
    this.startedAt = at;
    this.lastAt = at;
  }

  /** Fold one span in. Returns false for a span already seen (exporters retry). */
  add(span: OtlpSpan, a: Record<string, unknown>): boolean {
    const spanId = span.spanId ?? "";
    if (!spanId || this.seen.has(spanId)) return false;
    this.seen.add(spanId);
    if (this.seen.size > 50_000) this.seen.clear();
    const parent = span.parentSpanId || null;
    this.parents.set(spanId, parent);
    const start = iso(span.startTimeUnixNano) ?? new Date().toISOString();
    const end = iso(span.endTimeUnixNano);
    if (start < this.startedAt) this.startedAt = start;
    if ((end ?? start) > this.lastAt) this.lastAt = end ?? start;

    const op = str(a["gen_ai.operation.name"]) ?? "";
    const model = str(a["gen_ai.response.model"]) ?? str(a["gen_ai.request.model"]);
    if (model) this.model = model;
    this.name ??= str(a["tessera.session.name"]);
    this.cwd ??= str(a["tessera.cwd"]) ?? str(a["process.working_directory"]);
    this.repo ??= str(a["vcs.repository.name"]) ?? str(a["vcs.repository.url.full"])?.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?$/, "$1") ?? null;
    this.branch ??= str(a["vcs.ref.head.name"]) ?? str(a["vcs.repository.ref.name"]);
    if (str(a["tessera.session.status"]) === "ended") this.ended = true;

    if (op === "invoke_agent" || op === "create_agent") {
      const failed = isError(span);
      this.agents.set(spanId, {
        id: spanId,
        parent,
        type: str(a["gen_ai.agent.name"]) ?? span.name ?? "agent",
        description: str(a["gen_ai.agent.description"]),
        model,
        startedAt: start,
        endedAt: end,
        failed,
        failure: failed ? (span.status?.message ?? "agent failed") : null,
      });
      this.event(spanId, start, "agent.spawn", `spawned ${str(a["gen_ai.agent.name"]) ?? "agent"}`);
      if (end) this.event(`${spanId}:end`, end, failed ? "agent.fail" : "agent.done", `${str(a["gen_ai.agent.name"]) ?? "agent"} ${failed ? `failed: ${span.status?.message ?? ""}` : "done"}`, spanId);
      return true;
    }
    const usage = {
      input: num(a["gen_ai.usage.input_tokens"]),
      output: num(a["gen_ai.usage.output_tokens"]),
      cacheRead: num(a["gen_ai.usage.cache_read.input_tokens"] ?? a["gen_ai.usage.cache_read_input_tokens"]),
      cacheWrite: num(a["gen_ai.usage.cache_creation.input_tokens"] ?? a["gen_ai.usage.cache_creation_input_tokens"]),
    };
    const tool = op === "execute_tool" ? (str(a["gen_ai.tool.name"]) ?? span.name ?? "tool") : null;
    if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 || tool) {
      this.contributions.set(spanId, { parent, model, usage, tool });
      if (this.contributions.size > 20_000) this.contributions.delete(this.contributions.keys().next().value!);
    }
    if (tool && isError(span)) this.event(spanId, end ?? start, "tool.fail", `${tool} failed: ${clean(span.status?.message ?? "error", 200)}`, this.ownerOf(parent));
    return true;
  }

  private event(id: string, ts: string, kind: ActivityEvent["kind"], text: string, agentId: string | null = null): void {
    this.outbox.push({ id: `otlp-${id}-${kind}`.slice(0, 128), ts, kind, agentId, text: clean(text, 500) });
    if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
  }

  /** The nearest agent span above a span, or null for the session itself. */
  private ownerOf(spanId: string | null): string | null {
    let cur = spanId;
    for (let i = 0; cur && i < 64; i++) {
      if (this.agents.has(cur)) return cur;
      cur = this.parents.get(cur) ?? null;
    }
    return null;
  }

  /** The session as a Tessera report, recomputed from every span so far (late parents re-home earlier children). */
  report(): Report {
    const byOwner = new Map<string | null, { usage: Map<string, ModelUsage>; tools: Record<string, number> }>();
    const bucket = (o: string | null) => {
      let b = byOwner.get(o);
      if (!b) byOwner.set(o, (b = { usage: new Map(), tools: {} }));
      return b;
    };
    for (const c of this.contributions.values()) {
      const b = bucket(this.ownerOf(c.parent));
      if (c.tool) b.tools[c.tool] = (b.tools[c.tool] ?? 0) + 1;
      const m = c.model ?? this.model ?? "unknown";
      const u = b.usage.get(m) ?? { model: m, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      u.input += c.usage.input;
      u.output += c.usage.output;
      u.cacheRead += c.usage.cacheRead;
      u.cacheWrite += c.usage.cacheWrite;
      b.usage.set(m, u);
    }
    const sum = (list: ModelUsage[]) => list.reduce((t, u) => ({ input: t.input + u.input, output: t.output + u.output, cacheRead: t.cacheRead + u.cacheRead, cacheWrite: t.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const own = [...bucket(null).usage.values()];
    const agents: AgentReport[] = [...this.agents.values()].slice(-2000).map((g) => {
      const b = bucket(g.id);
      const usage = [...b.usage.values()];
      return {
        id: g.id,
        parentId: this.ownerOf(g.parent),
        kind: "subagent",
        type: clean(g.type ?? "agent", 120),
        description: g.description ? clean(g.description, 400) : null,
        model: g.model ?? usage[0]?.model ?? null,
        effort: null,
        status: g.endedAt ? (g.failed ? "failed" : "done") : "running",
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        tokens: sum(usage),
        usageByModel: usage,
        context: null,
        toolCalls: b.tools,
        skills: [],
        failure: g.failed ? { class: "unknown", at: g.endedAt ?? g.startedAt, tool: null, summary: clean(g.failure ?? "failed", 500), exitCode: null, outputTail: [] } : null,
        promptExcerpt: null,
        answerExcerpt: null,
      };
    });
    const running = agents.some((x) => x.status === "running") || Date.now() - Date.parse(this.lastAt) < 30_000;
    const events = this.outbox.splice(0, this.outbox.length);
    return {
      v: 1,
      sentAt: new Date().toISOString(),
      reporter: { kind: this.kind, version: this.version, schema: "1.0" },
      machine: { hostname: clean(this.hostname, 120), machineId: clean(this.machineId, 64) },
      session: {
        id: this.id,
        name: this.name ? clean(this.name, 200) : null,
        cwd: this.cwd,
        model: this.model,
        effort: null,
        status: this.ended ? "ended" : running ? "running" : "idle",
        waitReason: null,
        startedAt: this.startedAt,
        endedAt: this.ended ? this.lastAt : null,
        endReason: this.ended ? "otlp" : null,
        context: null,
        tokens: sum(own),
        usageByModel: own,
        ledgerCostUsd: null,
        blowouts: 0,
        git: this.repo || this.branch ? { repo: this.repo, branch: this.branch, worktree: null, ahead: 0, behind: 0, modified: 0 } : null,
        filesChanged: [],
        plan: null,
        agents,
        openAsk: null,
        tags: {},
        continuedFrom: null,
      },
      events,
    };
  }
}

/** Group a request's spans by session, folding each into its accumulator. Returns the sessions touched. */
export function foldTraces(body: OtlpTraces, sessions: Map<string, OtlpSession>, max = 5000): { touched: OtlpSession[]; spans: number; rejected: number } {
  const touched = new Set<OtlpSession>();
  let spans = 0;
  let rejected = 0;
  for (const rs of body.resourceSpans ?? []) {
    const res = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        if (++spans > max) {
          rejected++;
          continue;
        }
        const a = { ...res, ...attrs(span.attributes) };
        const sid = clean(str(a["tessera.session.id"]) ?? str(a["session.id"]) ?? str(a["gen_ai.conversation.id"]) ?? span.traceId ?? "", 128);
        if (!sid) {
          rejected++;
          continue;
        }
        let s = sessions.get(sid);
        if (!s) {
          s = new OtlpSession(sid, iso(span.startTimeUnixNano) ?? new Date().toISOString());
          sessions.set(sid, s);
        }
        s.kind = kindOf(str(res["service.name"]), str(a["gen_ai.system"]));
        s.version = clean(str(res["service.version"]) ?? "otlp", 40);
        s.hostname = str(res["host.name"]) ?? s.hostname;
        s.machineId = str(res["host.id"]) ?? str(res["host.name"]) ?? s.machineId;
        if (s.add(span, a)) touched.add(s);
      }
    }
  }
  return { touched: [...touched], spans, rejected };
}
