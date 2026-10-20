import { applyDlp, clean, type DlpSettings } from "@tessera/contract";
import { config } from "../config.js";
import type { SessionRecord } from "./types.js";

/**
 * "Explain this failure": a short reading of a failed tool call, by a small
 * Claude model, from what the reporter already sent (redacted on the machine)
 * with the organisation's DLP applied again here. Off unless an owner turns it
 * on and the server has a Claude API key. An explanation is kept a day, so
 * asking twice costs once.
 */

export type ExplainTarget = { kind: "agent"; id: string } | { kind: "action"; id: string };

export interface Explanation {
  text: string;
  model: string;
  at: string;
  cached: boolean;
}

const SYSTEM =
  "You explain why one step of an AI coding agent's session failed, for the engineer or approver looking at it. " +
  "Use only the text you are given. Answer in at most three short lines, in plain words: what failed, the likely cause, and what to try next. " +
  "If the text does not show the cause, say so instead of guessing. No preamble, no headings, no markdown.";

const DAY = 86_400_000;
const cache = new Map<string, { e: Explanation; until: number }>();
const used = new Map<string, number[]>();

export class ExplainError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

/** What the model reads: the failed call, its error output, and the calls just before it. Null when the target is not a failure. */
export function failureText(rec: SessionRecord, target: ExplainTarget, dlp: DlpSettings): { key: string; text: string } | null {
  const scrub = (t: string, max: number) => applyDlp(clean(t, max), dlp);
  const lines: string[] = [];
  let key: string;
  let agentId: string | null;
  if (target.kind === "agent") {
    const a = rec.agents.find((x) => x.id === target.id);
    if (!a?.failure) return null;
    key = `agent:${a.id}:${a.failure.at}`;
    agentId = a.id;
    lines.push(`Agent: ${scrub(a.type ?? a.kind, 80)}${a.description ? ` (${scrub(a.description, 200)})` : ""}`);
    lines.push(`Failure: ${a.failure.class.replace(/_/g, " ")}${a.failure.tool ? ` in ${scrub(a.failure.tool, 80)}` : ""}${a.failure.exitCode !== null ? `, exit code ${a.failure.exitCode}` : ""}`);
    lines.push(`Summary: ${scrub(a.failure.summary, 600)}`);
    if (a.failure.outputTail.length) lines.push(`Last lines of its output:\n${scrub(a.failure.outputTail.join("\n"), 3000)}`);
  } else {
    const act = rec.activity?.find((x) => x.id === target.id);
    if (!act || act.status !== "failed") return null;
    key = `action:${act.id}`;
    agentId = act.agentId;
    lines.push(`Tool call: ${scrub(act.summary, 600)}`);
    lines.push(`Error: ${scrub(act.error ?? "no error text was reported", 1500)}`);
  }
  const before = (rec.activity ?? []).filter((x) => x.agentId === agentId && x.id !== target.id).slice(-6);
  if (before.length) lines.push(`Tool calls just before it, oldest first:\n${before.map((x) => `- ${scrub(x.summary, 200)}: ${x.status}${x.error ? ` (${scrub(x.error, 160)})` : ""}`).join("\n")}`);
  if (rec.git?.repo) lines.push(`Repository: ${scrub(rec.git.repo, 200)}`);
  return { key: `${rec.orgId}:${rec.id}:${key}`, text: lines.join("\n") };
}

/** One organisation's explanations in the last hour, as a limit against a loop or a script running up the bill. */
function allow(orgId: string, now: number): boolean {
  const recent = (used.get(orgId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= config.explainPerHour) return false;
  recent.push(now);
  used.set(orgId, recent);
  return true;
}

export async function explainFailure(rec: SessionRecord, target: ExplainTarget, dlp: DlpSettings, now = Date.now()): Promise<Explanation> {
  if (!config.anthropicApiKey) throw new ExplainError("Explaining failures needs a Claude API key on the server (ANTHROPIC_API_KEY). Ask whoever runs Tessera to set it.", 503);
  const input = failureText(rec, target, dlp);
  if (!input) throw new ExplainError("That step did not fail, or the session no longer has its details.", 404);
  const hit = cache.get(input.key);
  if (hit && hit.until > now) return { ...hit.e, cached: true };
  if (!allow(rec.orgId, now)) throw new ExplainError(`Your organisation has asked for ${config.explainPerHour} explanations in the last hour, the limit. Try again later.`, 429);
  let res: Response;
  try {
    res = await fetch(`${config.anthropicApiUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.explainModel, max_tokens: 300, system: SYSTEM, messages: [{ role: "user", content: input.text }] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const err = e as Error;
    throw new ExplainError(`The Claude API did not answer (${err.name === "TimeoutError" ? "no answer within 20 seconds" : err.message}). Try again in a minute.`, 502);
  }
  const body = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; error?: { message?: string } } | null;
  if (!res.ok) {
    // The API's own message says what is wrong (a bad key, an unknown model); it never contains the key.
    throw new ExplainError(`The Claude API refused the request (${res.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ""}). Check the server's ANTHROPIC_API_KEY and EXPLAIN_MODEL.`, 502);
  }
  const text = (body?.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text!.trim()).join("\n").trim();
  if (!text) throw new ExplainError("The Claude API answered with no text. Try again.", 502);
  const e: Explanation = { text: text.slice(0, 1200), model: config.explainModel, at: new Date(now).toISOString(), cached: false };
  cache.set(input.key, { e, until: now + DAY });
  if (cache.size > 5000) for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
  return e;
}
