import type { AskDetail } from "./report.js";

/**
 * What an approver should know before saying yes. These are deterministic
 * checks on the command, the paths and the URL of one tool call: they flag,
 * they do not decide. Every pattern is anchored or bounded, and inputs are
 * already capped in length, so the whole assessment is linear.
 */

export type RiskLevel = "high" | "medium" | "info";

export interface RiskFlag {
  code: string;
  level: RiskLevel;
  /** Short label for a chip: "Deletes files". */
  label: string;
  /** What was matched, for the tooltip: "rm -rf build/". */
  detail: string;
}

export interface RiskInput {
  tool: string;
  command?: string | null;
  paths?: string[];
  url?: string | null;
  cwd?: string | null;
  writeBytes?: number | null;
}

const SECRET_PATH = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore)|credentials(\.json)?|secrets?(\.ya?ml|\.json)?|\.aws\/.*|\.ssh\/.*|\.kube\/config|\.docker\/config\.json|\.gnupg\/.*)$/i;
const CI_PATH = /(^|\/)(\.github\/workflows\/.*|\.gitlab-ci\.ya?ml|Jenkinsfile|\.circleci\/.*|Dockerfile(\..*)?|docker-compose(\..*)?\.ya?ml|\.pre-commit-config\.yaml|\.husky\/.*)$/i;
const DEP_MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(\.lock)?|composer\.json)$/i;

interface CommandRule {
  code: string;
  level: RiskLevel;
  label: string;
  re: RegExp;
}

// Each regex is tested against every segment of a command chain, so "cd x && rm -rf y" is seen.
const COMMAND_RULES: CommandRule[] = [
  { code: "delete", level: "high", label: "Deletes files", re: /^(sudo\s+)?(rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)|rmdir\b|find\b.*\s-delete\b|git\s+clean\s+-[a-zA-Z]*[fdx]|git\s+checkout\s+--\s|git\s+restore\b|git\s+reset\s+--hard|git\s+stash\s+(drop|clear)\b|shred\b|truncate\s+-s\s*0)/ },
  { code: "history", level: "high", label: "Rewrites git history", re: /^git\s+(push\s+.*(--force|-f\b|\+\w)|branch\s+-D\b|rebase\b|filter-branch\b|filter-repo\b|reflog\s+expire|update-ref\s+-d)/ },
  { code: "push-main", level: "medium", label: "Pushes to a main branch", re: /^git\s+push\b.*\b(main|master|production|release)\b/ },
  { code: "infra", level: "high", label: "Changes infrastructure", re: /^(sudo\s+)?(terraform\s+(apply|destroy|import|taint|state\s+(rm|mv|push))|tofu\s+(apply|destroy)|pulumi\s+(up|destroy|refresh)|kubectl\s+(apply|delete|replace|patch|scale|rollout|drain|cordon|exec)|helm\s+(install|upgrade|uninstall|rollback|delete)|ansible(-playbook)?\b|aws\s+\S+\s+(create|delete|put|update|terminate|modify|run-instances|stop|start|reboot|attach|detach)|gcloud\s+.*\s(create|delete|update|deploy|run|ssh)\b|az\s+.*\s(create|delete|update|deploy|start|stop|restart)\b|docker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm|stop|kill)|docker\s+compose\s+(down|rm)|systemctl\s+(stop|restart|disable|mask)|fly\s+(deploy|scale|destroy|machines)|vercel\b.*--prod|netlify\s+deploy\b.*--prod|serverless\s+(deploy|remove)|cdk\s+(deploy|destroy)|sam\s+deploy)/ },
  { code: "database", level: "high", label: "Changes a database", re: /^(sudo\s+)?(psql\b|mysql\b|mysqlsh\b|mongosh?\b|redis-cli\b|sqlite3\b|prisma\s+(migrate|db\s+(push|execute|seed))|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize(-cli)?\s+db:|typeorm\s+migration:run|rails\s+db:(migrate|drop|reset|schema:load|seed)|bin\/rails\s+db:|alembic\s+(upgrade|downgrade)|python\s+manage\.py\s+(migrate|flush|dbshell)|dbmate\b|flyway\b|liquibase\b|goose\s+(up|down)|atlas\s+(migrate|schema)\s+apply|pg_restore\b|mongorestore\b|.*db:(migrate|drop|reset|seed|push)\b)/ },
  { code: "sql", level: "high", label: "Destructive SQL", re: /\b(drop\s+(table|database|schema|index)|truncate\s+(table\s+)?\w|delete\s+from\s+\w|alter\s+table\s+\w)\b/i },
  { code: "publish", level: "medium", label: "Publishes or deploys", re: /^(npm\s+publish|pnpm\s+publish|yarn\s+(npm\s+)?publish|cargo\s+publish|gem\s+push|twine\s+upload|poetry\s+publish|mvn\s+deploy|gradle\s+publish|docker\s+push|gh\s+release\s+(create|upload)|git\s+tag\s+(?!-l|--list)|gcloud\s+app\s+deploy|eb\s+deploy|cap\s+\w+\s+deploy|kamal\s+deploy)/ },
  { code: "remote-code", level: "high", label: "Runs downloaded code", re: /^((curl|wget)\b.*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b|(ba|z)?sh\s+<\(\s*(curl|wget)|(npx|pnpm\s+dlx|bunx)\s+.*https?:\/\/|pip3?\s+install\s+.*(https?:\/\/|git\+))/ },
  { code: "privilege", level: "medium", label: "Elevated privileges", re: /^(sudo\b|su\s|doas\b|chmod\s+(-R\s+)?[0-7]*777|chmod\s+(-R\s+)?[ugoa]*\+s|chown\s+(-R\s+)?root|setcap\b)/ },
  { code: "install", level: "info", label: "Installs packages", re: /^(sudo\s+)?(npm\s+(i|install|add|ci)\b|pnpm\s+(i|install|add)\b|yarn\s+(add|install)?\b|pip3?\s+install\b|uv\s+(pip\s+install|add|sync)|poetry\s+(add|install)|cargo\s+(add|install)|gem\s+install|bundle\s+install|go\s+(get|install)\b|brew\s+(install|upgrade)|apt(-get)?\s+(install|upgrade)|apk\s+add|dnf\s+install|yum\s+install|composer\s+(require|install))/ },
  { code: "network", level: "info", label: "Reaches the network", re: /^(curl\b|wget\b|ssh\b|scp\b|sftp\b|rsync\b.*:|nc\b|ncat\b|telnet\b|http\b|xh\b|gh\s+api\b)/ },
  { code: "env", level: "info", label: "Reads environment or dotfiles", re: /^(env\b|printenv\b|set\s*$|export\s+-p|cat\s+.*(\.env|~\/\.|\.netrc|\.npmrc|\.pgpass|\/etc\/(passwd|shadow)))/ },
  { code: "background", level: "info", label: "Starts a background process", re: /(^|\s)(nohup\b|setsid\b|disown\b|&\s*$)|^(pm2|forever|screen|tmux)\s/ },
];

function segments(command: string): string[] {
  const parts = command.split(/\s*(?:&&|\|\||;|\n)\s*/).map((p) => p.trim()).filter(Boolean);
  // Also look past leading env assignments and "cd dir;" prefixes: "FOO=1 rm -rf x".
  const bare = parts.map((p) => p.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ""));
  return [...new Set([command.trim(), ...parts, ...bare])];
}

function isSecretPath(p: string): boolean {
  return SECRET_PATH.test(p);
}

function outsideCwd(p: string, cwd: string | null | undefined): boolean {
  if (!cwd || !p.startsWith("/")) return false;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (p === cwd || p.startsWith(base)) return false;
  return !/^\/(tmp|private\/tmp|var\/folders|dev\/null)(\/|$)/.test(p);
}

/** Flags for one tool call, highest level first, each code at most once. */
export function assessRisk(input: RiskInput): RiskFlag[] {
  const flags = new Map<string, RiskFlag>();
  const add = (f: RiskFlag) => {
    if (!flags.has(f.code)) flags.set(f.code, f);
  };
  const paths = input.paths ?? [];
  const tool = input.tool;

  if (input.command) {
    const cmd = input.command.slice(0, 4000);
    for (const seg of segments(cmd)) {
      for (const r of COMMAND_RULES) {
        const m = r.re.exec(seg);
        if (m) add({ code: r.code, level: r.level, label: r.label, detail: seg.slice(0, 120) });
      }
      // Secrets named in a command: "cat .env", "cp ~/.aws/credentials ."
      const words = seg.split(/\s+/).slice(1, 40);
      for (const w of words) if (isSecretPath(w.replace(/^["']|["']$/g, ""))) add({ code: "secrets", level: "high", label: "Touches secrets", detail: w.slice(0, 120) });
    }
  }

  for (const p of paths) {
    if (isSecretPath(p)) add({ code: "secrets", level: "high", label: "Touches secrets", detail: p });
    if (tool !== "Read" && tool !== "Glob" && tool !== "Grep" && outsideCwd(p, input.cwd)) add({ code: "outside", level: "medium", label: "Writes outside the project", detail: p });
    if (tool !== "Read" && CI_PATH.test(p)) add({ code: "ci", level: "info", label: "Changes CI or build config", detail: p });
    if (tool !== "Read" && DEP_MANIFEST.test(p)) add({ code: "deps", level: "info", label: "Changes dependencies", detail: p });
  }

  if (input.url) {
    if (/^http:\/\//i.test(input.url)) add({ code: "plain-http", level: "medium", label: "Plain HTTP", detail: input.url.slice(0, 120) });
    if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/]*\.(internal|local|corp|lan)(\/|:|$))/i.test(input.url)) add({ code: "internal-url", level: "info", label: "Internal address", detail: input.url.slice(0, 120) });
  }

  if (input.writeBytes != null && input.writeBytes > 100_000) add({ code: "large-write", level: "info", label: "Large file write", detail: `${Math.round(input.writeBytes / 1024)} KB` });

  const order: Record<RiskLevel, number> = { high: 0, medium: 1, info: 2 };
  return [...flags.values()].sort((a, b) => order[a.level] - order[b.level]);
}

/** Convenience for an open prompt: pull the inputs out of its detail. */
export function riskForAsk(tool: string | null, detail: AskDetail | null | undefined, cwd: string | null | undefined): RiskFlag[] {
  if (!detail) return [];
  const paths = [...detail.paths, ...detail.edits.map((e) => e.path), ...(detail.write ? [detail.write.path] : [])];
  return assessRisk({ tool: tool ?? "tool", command: detail.command, paths, url: detail.url, cwd, writeBytes: detail.write?.bytes ?? null });
}

/**
 * The rule an approver can remember for the rest of the session, when the
 * runtime did not suggest one: the command's first words with a wildcard, so
 * "pnpm test --filter x" becomes "pnpm test:*".
 */
export function deriveRule(tool: string, detail: AskDetail | null | undefined): { tool: string; content: string | null } | null {
  if (detail?.suggestedRules.length) return detail.suggestedRules[0]!;
  if (tool === "Bash" && detail?.command) {
    const first = segments(detail.command)[1] ?? detail.command.trim();
    const words = first.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    // Keep the program and its subcommand when the subcommand is a plain word: "git status", "pnpm test".
    const head = words.length > 1 && /^[a-z][\w:-]*$/i.test(words[1]!) && !words[1]!.startsWith("-") ? words.slice(0, 2) : words.slice(0, 1);
    return { tool, content: `${head.join(" ")}:*` };
  }
  if ((tool === "Edit" || tool === "Write" || tool === "Read") && (detail?.edits[0]?.path || detail?.write?.path || detail?.paths[0])) {
    const p = detail.edits[0]?.path ?? detail.write?.path ?? detail.paths[0]!;
    const dir = p.replace(/\/[^/]*$/, "");
    return { tool, content: `${dir}/**` };
  }
  if (tool === "WebFetch" && detail?.url) {
    const host = /^https?:\/\/([^/:?#]+)/i.exec(detail.url)?.[1];
    return host ? { tool, content: `domain:${host}` } : null;
  }
  return null;
}

/** "Bash(pnpm test:*)" as Claude Code writes it. */
export function ruleText(r: { tool: string; content: string | null }): string {
  return r.content ? `${r.tool}(${r.content})` : r.tool;
}
