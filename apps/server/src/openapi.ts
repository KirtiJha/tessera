import { config } from "./config.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = "OK") => ({ description, content: { "application/json": { schema } } });
const err = { description: "Error", content: { "application/json": { schema: ref("Error") } } };
const sid = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session id" };
const errors = { "400": err, "401": err, "403": err, "404": err, "409": err };

/**
 * The public API: the console's own endpoints under /api/v1, called with an
 * API key (`Authorization: Bearer tsk_…`). Each operation names the scope it needs.
 */
export function openapi(): Record<string, unknown> {
  const op = (summary: string, scope: string, extra: Record<string, unknown> = {}) => ({ summary, security: [{ apiKey: [] }], "x-scope": scope, description: `Needs the \`${scope}\` scope.`, ...extra });
  return {
    openapi: "3.1.0",
    info: {
      title: "Tessera API",
      version: "1.0.0",
      description:
        "Read the live fleet, act on sessions, read spend and audit, and manage tool-call policy. Authenticate with an API key made under Account → API keys. A key acts as the person who made it, with their current role, limited to the scopes chosen.",
    },
    servers: [{ url: `${config.publicUrl}/api/v1` }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "tsk_…" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
        Tokens: { type: "object", properties: { input: { type: "integer" }, output: { type: "integer" }, cacheRead: { type: "integer" }, cacheWrite: { type: "integer" } } },
        OpenAsk: { type: ["object", "null"], properties: { id: { type: "string" }, kind: { enum: ["question", "plan", "permission"] }, tool: { type: ["string", "null"] }, prompt: { type: "string" }, options: { type: "array", items: { type: "string" } }, createdAt: { type: "string", format: "date-time" } } },
        Session: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: ["string", "null"] },
            ownerId: { type: ["string", "null"] },
            ownerName: { type: ["string", "null"] },
            status: { enum: ["running", "waiting", "idle", "ended"] },
            stale: { type: "boolean" },
            waitReason: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            startedAt: { type: "string", format: "date-time" },
            endedAt: { type: ["string", "null"], format: "date-time" },
            costUsd: { type: ["number", "null"], description: "Estimate from tokens at the organisation's prices" },
            tokens: ref("Tokens"),
            git: { type: ["object", "null"], properties: { repo: { type: ["string", "null"] }, branch: { type: ["string", "null"] } } },
            openAsk: ref("OpenAsk"),
            assignee: { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" } } },
            stopRequested: { type: "boolean" },
            agents: { type: "array", items: { type: "object" } },
            tags: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        PolicyRule: {
          type: "object",
          required: ["id", "name", "effect", "match"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            effect: { enum: ["deny", "ask", "allow"] },
            mode: { enum: ["enforce", "dry_run"] },
            enabled: { type: "boolean" },
            reason: { type: "string" },
            match: {
              type: "object",
              properties: Object.fromEntries(["tools", "commands", "paths", "urls", "models", "repos", "branches", "teams"].map((k) => [k, { type: "array", items: { type: "string" } }])),
            },
          },
        },
      },
    },
    paths: {
      "/fleet/state": { get: op("Live sessions, KPIs and recent events", "fleet:read", { responses: { "200": json({ type: "object", properties: { sessions: { type: "array", items: ref("Session") }, kpis: { type: "object" }, recentEvents: { type: "array" } } }), ...errors } }) },
      "/fleet/stream": { get: op("Server-Sent Events: snapshot, then sessions/events/removed/kpis messages", "fleet:read", { responses: { "200": { description: "text/event-stream" } } }) },
      "/fleet/sessions/{id}": { get: op("One session with events, prompts and cost series", "fleet:read", { parameters: [sid], responses: { "200": json({ type: "object", properties: { session: ref("Session"), live: { type: "boolean" }, canAct: { type: "boolean" } } }), ...errors } }) },
      "/fleet/sessions/{id}/timeline": { get: op("Everything needed to replay a session", "fleet:read", { parameters: [sid], responses: { "200": json({ type: "object" }), ...errors } }) },
      "/fleet/history": {
        get: op("Ended sessions, newest first", "fleet:read", {
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "pageSize", in: "query", schema: { type: "integer", minimum: 10, maximum: 100 } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          ],
          responses: { "200": json({ type: "object" }), ...errors },
        }),
      },
      "/fleet/sessions/{id}/answer": {
        post: op("Answer the open prompt: allow/deny a permission, approve/reject a plan, answer a question", "sessions:act", {
          parameters: [sid],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["askId", "decision"], properties: { askId: { type: "string" }, decision: { enum: ["allow", "deny", "approve", "reject", "answer"] }, text: { type: "string" }, option: { type: "string" } } } } } },
          responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, deliveryId: { type: "string" } } }), ...errors },
        }),
      },
      "/fleet/sessions/{id}/message": { post: op("Queue a message, delivered when the session next pauses", "sessions:act", { parameters: [sid], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 4000 } } } } } }, responses: { "200": json({ type: "object" }), ...errors } }) },
      "/fleet/sessions/{id}/pause": { post: op("Pause (deny new tool calls) or resume", "sessions:act", { parameters: [sid], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["paused"], properties: { paused: { type: "boolean" }, reason: { type: "string" } } } } } }, responses: { "200": json({ type: "object" }), ...errors } }) },
      "/fleet/sessions/{id}/stop": { post: op("Stop the session's turn at its next tool call", "sessions:act", { parameters: [sid], requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } }, responses: { "200": json({ type: "object" }), ...errors } }) },
      "/fleet/sessions/{id}/assign": { post: op("Hand the session to someone, or back (userId null)", "sessions:act", { parameters: [sid], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["userId"], properties: { userId: { type: ["string", "null"], format: "uuid" } } } } } }, responses: { "200": json({ type: "object" }), ...errors } }) },
      "/analytics": {
        get: op("Spend per day, totals, groups, model mix and forecast", "analytics:read", {
          parameters: [
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            { name: "days", in: "query", schema: { type: "integer" } },
            { name: "groupBy", in: "query", schema: { type: "string", examples: ["team", "cost_center", "person", "repo", "ticket", "model", "tag:project"] } },
            { name: "team", in: "query", schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": json({ type: "object" }), ...errors },
        }),
      },
      "/analytics/export.csv": { get: op("Chargeback CSV per group (detail=groups) or per session (detail=sessions). The key's owner must be an admin.", "analytics:read", { parameters: [{ name: "detail", in: "query", schema: { enum: ["groups", "sessions"] } }, { name: "from", in: "query", schema: { type: "string", format: "date" } }, { name: "to", in: "query", schema: { type: "string", format: "date" } }, { name: "groupBy", in: "query", schema: { type: "string" } }], responses: { "200": { description: "text/csv" }, ...errors } }) },
      "/admin/audit": { get: op("Audit log, newest first", "audit:read", { parameters: [{ name: "before", in: "query", schema: { type: "integer" } }, { name: "limit", in: "query", schema: { type: "integer", maximum: 200 } }, { name: "action", in: "query", schema: { type: "string" }, description: "Prefix, e.g. session.answer" }], responses: { "200": json({ type: "object" }), ...errors } }) },
      "/admin/audit/verify": { get: op("Verify the audit log's hash chain", "audit:read", { responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, checked: { type: "integer" }, brokenAt: { type: ["integer", "null"] } } }), ...errors } }) },
      "/admin/policy": {
        get: op("The tool-call policy in force, its versions and recent hit counts", "policy:read", { responses: { "200": json({ type: "object", properties: { version: { type: "integer" }, rules: { type: "array", items: ref("PolicyRule") } } }), ...errors } }),
        put: op("Save a new policy version. baseVersion must be the version you read; 409 if someone saved since.", "policy:write", { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["rules", "baseVersion"], properties: { rules: { type: "array", items: ref("PolicyRule") }, baseVersion: { type: "integer" }, note: { type: "string" } } } } } }, responses: { "200": json({ type: "object", properties: { version: { type: "integer" } } }), ...errors } }),
      },
      "/admin/policy/test": { post: op("Evaluate a tool call against the saved policy or a draft", "policy:read", { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["call"], properties: { rules: { type: "array", items: ref("PolicyRule") }, call: { type: "object", required: ["tool"], properties: { tool: { type: "string" }, command: { type: "string" }, path: { type: "string" }, url: { type: "string" }, branch: { type: "string" }, repo: { type: "string" } } } } } } } }, responses: { "200": json({ type: "object" }), ...errors } }) },
      "/admin/policy/decisions": { get: op("Recent policy decisions", "policy:read", { responses: { "200": json({ type: "object" }), ...errors } }) },
    },
  };
}
