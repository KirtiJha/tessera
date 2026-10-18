import { z } from "zod";

/**
 * Tool-call policy. An ordered list of rules; the first enabled rule that
 * matches a tool call decides it, and a call no rule matches is allowed.
 *
 * Patterns are globs, never regular expressions, so a rule cannot be written
 * that takes super-linear time on a long command: `*` matches any run of
 * characters (within one path segment for paths), `**` crosses segments, `?`
 * matches one character. Matching is a bounded dynamic programme, O(text ×
 * pattern), on inputs capped in length.
 */

export const PolicyEffect = z.enum(["deny", "ask", "allow"]);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

const glob = z.string().trim().min(1).max(300);

export const PolicyMatch = z.object({
  /** Tool names: Bash, Edit, Write, Read, WebFetch, mcp__github__*. */
  tools: z.array(glob).max(50).default([]),
  /** Shell command globs, for Bash: "terraform apply*", "*rm -rf /*". */
  commands: z.array(glob).max(50).default([]),
  /** File path globs, absolute or relative to the session's directory: "**\/.env", "infra/prod/**". */
  paths: z.array(glob).max(50).default([]),
  /** URL globs for web tools: "https://*.internal.example.com/**". */
  urls: z.array(glob).max(50).default([]),
  /** Session model ids: "claude-opus-*". */
  models: z.array(glob).max(20).default([]),
  /** Repository and branch of the session: "acme/payments", "main". */
  repos: z.array(glob).max(50).default([]),
  branches: z.array(glob).max(50).default([]),
  /** Team ids the session's owner belongs to. Empty means everyone. */
  teams: z.array(z.string().uuid()).max(50).default([]),
});
export type PolicyMatch = z.infer<typeof PolicyMatch>;

export const PolicyRule = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  effect: PolicyEffect,
  /** dry_run records what the rule would have done and allows the call. */
  mode: z.enum(["enforce", "dry_run"]).default("enforce"),
  enabled: z.boolean().default(true),
  /** Shown to the engineer in the terminal, and to reviewers. */
  reason: z.string().trim().max(400).default(""),
  match: PolicyMatch,
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyDoc = z.object({ rules: z.array(PolicyRule).max(200) });
export type PolicyDoc = z.infer<typeof PolicyDoc>;

/** What the reporter tells the server before a tool call. Everything is redacted on the machine first. */
export const DecideRequest = z.object({
  sessionId: z.string().min(1).max(128),
  tool: z.string().min(1).max(120),
  command: z.string().max(2000).optional(),
  paths: z.array(z.string().max(400)).max(20).optional(),
  url: z.string().max(1000).optional(),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

export interface DecideResponse {
  decision: "allow" | "deny" | "ask";
  reason: string | null;
}

/** The facts a rule is matched against. */
export interface ToolCall {
  tool: string;
  command?: string | null;
  paths?: string[];
  url?: string | null;
  cwd?: string | null;
  model?: string | null;
  repo?: string | null;
  branch?: string | null;
  teamId?: string | null;
}

/**
 * Glob match by dynamic programming. `segmented` makes `*` and `?` stop at "/"
 * while `**` crosses it (paths, URLs); otherwise `*` matches anything.
 */
export function globMatch(pattern: string, text: string, segmented = false): boolean {
  // Tokenise the pattern: literal chars ("=x"), "?", "*", "**", and "**/" (zero or more directories).
  const toks: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (segmented && pattern[i + 1] === "/") {
        toks.push("**/");
        i++;
      } else toks.push("**");
    } else if (c === "*") toks.push("*");
    else if (c === "?") toks.push("?");
    else toks.push(`=${c}`);
  }
  const n = text.length;
  // prev[j]: tokens [0, t) match text [0, j)
  let prev = new Uint8Array(n + 1);
  prev[0] = 1;
  for (const tok of toks) {
    const cur = new Uint8Array(n + 1);
    if (tok === "*" || tok === "**") {
      const crosses = tok !== "*" || !segmented;
      // cur[j] = prev[j] || (cur[j-1] && text[j-1] allowed)
      for (let j = 0; j <= n; j++) {
        if (prev[j]) cur[j] = 1;
        else if (j > 0 && cur[j - 1] && (crosses || text[j - 1] !== "/")) cur[j] = 1;
      }
    } else if (tok === "**/") {
      // Zero or more whole directories: "" or "a/" or "a/b/".
      for (let j = 0; j <= n; j++) {
        if (!prev[j]) continue;
        cur[j] = 1;
        for (let k = j; k < n; k++) if (text[k] === "/") cur[k + 1] = 1;
      }
    } else {
      for (let j = 1; j <= n; j++) {
        if (!prev[j - 1]) continue;
        const ch = text[j - 1]!;
        if (tok === "?" ? !(segmented && ch === "/") : tok.slice(1) === ch) cur[j] = 1;
      }
    }
    prev = cur;
  }
  return prev[n] === 1;
}

function relativeTo(path: string, cwd: string | null | undefined): string | null {
  if (!cwd || !path.startsWith("/")) return null;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

function anyGlob(globs: string[], value: string | null | undefined, segmented = false): boolean {
  if (!globs.length) return true;
  if (value == null) return false;
  return globs.some((g) => globMatch(g, value, segmented));
}

/** Does every condition the rule sets hold for this call? Unset conditions do not constrain. */
export function ruleMatches(rule: PolicyRule, call: ToolCall): boolean {
  const m = rule.match;
  if (!anyGlob(m.tools, call.tool)) return false;
  if (m.commands.length) {
    const cmd = call.command?.trim();
    if (!cmd) return false;
    // Match the whole command and each part of a chain, so "a && terraform apply" is caught by "terraform apply*".
    const parts = [cmd, ...cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)];
    if (!m.commands.some((g) => parts.some((p) => globMatch(g, p)))) return false;
  }
  if (m.paths.length) {
    const paths = call.paths ?? [];
    if (!paths.length) return false;
    const hit = paths.some((p) => {
      const rel = relativeTo(p, call.cwd);
      return m.paths.some((g) => globMatch(g, p, true) || (rel !== null && globMatch(g, rel, true)) || (!g.includes("/") && globMatch(g, p.split("/").pop() ?? p, true)));
    });
    if (!hit) return false;
  }
  if (!anyGlob(m.urls, call.url, true)) return false;
  if (!anyGlob(m.models, call.model)) return false;
  if (!anyGlob(m.repos, call.repo)) return false;
  if (!anyGlob(m.branches, call.branch)) return false;
  if (m.teams.length && (!call.teamId || !m.teams.includes(call.teamId))) return false;
  return true;
}

export interface PolicyVerdict {
  /** What happens to the call. */
  decision: "allow" | "deny" | "ask";
  /** The enforcing rule that decided, if any. */
  rule: PolicyRule | null;
  /** Dry-run rules that matched before the deciding one, with what they would have done. */
  dryRun: PolicyRule[];
}

/** First enforcing rule that matches decides; dry-run rules on the way are reported, not applied. */
export function evaluatePolicy(doc: PolicyDoc, call: ToolCall): PolicyVerdict {
  const dryRun: PolicyRule[] = [];
  for (const rule of doc.rules) {
    if (!rule.enabled || !ruleMatches(rule, call)) continue;
    if (rule.mode === "dry_run") {
      dryRun.push(rule);
      continue;
    }
    return { decision: rule.effect, rule, dryRun };
  }
  return { decision: "allow", rule: null, dryRun };
}
