import { evaluatePolicy, type PolicyDoc, type PolicyRule, type ToolCall } from "./policy.js";
import type { AskDetail } from "./report.js";
import { assessRisk, deriveRule, ruleText } from "./risk.js";

/**
 * Allow rules worth adding, found in the prompts people keep approving. A
 * pattern is suggested when it has been asked about often, never denied from
 * Tessera, carries no high-risk flag, and no rule already decides it.
 */

export interface PastAsk {
  /** The one-line prompt the reporter sent: "Bash(pnpm test --filter x)", "Edit(/r/src/a.ts)". */
  prompt: string;
  /** "allow" | "deny" | null (closed in the terminal, decision unknown). */
  decision: string | null;
  person: string | null;
  at: string;
}

export interface RuleSuggestion {
  /** Stable key for applying it: the rule as Claude Code writes it. */
  key: string;
  tool: string;
  content: string | null;
  asked: number;
  allowedHere: number;
  people: number;
  last: string;
  example: string;
}

/** "Bash(pnpm test --filter x)" → the call it stands for. */
export function parsePrompt(prompt: string): { tool: string; arg: string | null } | null {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s.exec(prompt.trim());
  if (!m) return null;
  return { tool: m[1]!, arg: m[2] ?? null };
}

function detailFor(tool: string, arg: string | null): AskDetail {
  const d: AskDetail = { command: null, description: null, edits: [], write: null, url: null, paths: [], rationale: null, forcedBy: null, suggestedRules: [], questions: [] };
  if (!arg) return d;
  if (tool === "Bash") d.command = arg;
  else if (/^https?:\/\//i.test(arg)) d.url = arg;
  else if (arg.startsWith("/") || /^[A-Za-z]:\\/.test(arg)) d.paths = [arg];
  return d;
}

function sampleCall(tool: string, arg: string | null): ToolCall {
  const d = detailFor(tool, arg);
  return { tool, command: d.command, paths: d.paths, url: d.url };
}

export function suggestRules(asks: PastAsk[], doc: PolicyDoc, opts: { minAsked?: number } = {}): RuleSuggestion[] {
  const minAsked = opts.minAsked ?? 5;
  const groups = new Map<string, RuleSuggestion & { denied: number; who: Set<string>; risky: boolean; decided: boolean }>();
  for (const a of asks) {
    const p = parsePrompt(a.prompt);
    if (!p || p.tool === "ExitPlanMode" || p.tool === "AskUserQuestion") continue;
    const rule = deriveRule(p.tool, detailFor(p.tool, p.arg));
    if (!rule) continue;
    const key = ruleText(rule);
    let g = groups.get(key);
    if (!g) {
      const call = sampleCall(p.tool, p.arg);
      const risky = assessRisk({ tool: p.tool, command: call.command, paths: call.paths, url: call.url }).some((f) => f.level === "high");
      // A rule that already decides this call (deny, ask, or allow) was put there on purpose.
      const decided = !!evaluatePolicy(doc, call).rule;
      g = { key, tool: rule.tool, content: rule.content, asked: 0, allowedHere: 0, people: 0, last: a.at, example: a.prompt, denied: 0, who: new Set(), risky, decided };
      groups.set(key, g);
    }
    g.asked++;
    if (a.decision === "allow") g.allowedHere++;
    if (a.decision === "deny") g.denied++;
    if (a.person) g.who.add(a.person);
    if (a.at > g.last) g.last = a.at;
  }
  return [...groups.values()]
    .filter((g) => g.asked >= minAsked && g.denied === 0 && !g.risky && !g.decided)
    .sort((x, y) => y.asked - x.asked || y.allowedHere - x.allowedHere)
    .slice(0, 12)
    .map(({ key, tool, content, asked, allowedHere, who, last, example }) => ({ key, tool, content, asked, allowedHere, people: who.size, last, example }));
}

/** The policy rule a suggestion becomes: an allow rule matching the same calls the Claude Code rule would. */
export function ruleFromSuggestion(s: { tool: string; content: string | null }, id: string): PolicyRule {
  const match: PolicyRule["match"] = { tools: [s.tool], commands: [], paths: [], urls: [], models: [], repos: [], branches: [], teams: [] };
  const c = s.content ?? "";
  if (s.tool === "Bash" && c.endsWith(":*")) {
    const prefix = c.slice(0, -2).trim();
    // The prefix on its own, or followed by arguments; never "pnpm testing" for "pnpm test".
    match.commands = [prefix, `${prefix} *`];
  } else if (c.startsWith("domain:")) {
    const host = c.slice("domain:".length);
    match.urls = [`https://${host}`, `https://${host}/**`];
  } else if (c) {
    match.paths = [c];
  }
  return {
    id,
    name: `Allow ${ruleText(s)}`,
    effect: "allow",
    mode: "enforce",
    enabled: true,
    reason: "Approved again and again, never denied: allowed without asking.",
    match,
  };
}
