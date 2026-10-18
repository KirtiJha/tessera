import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ApiError, clearConf, Client, confPath, loadConf, saveConf } from "./client.js";
import { ago, c, parseArgs, str, table, usd, type Args } from "./util.js";

export const VERSION = "0.1.0";

interface Session {
  id: string;
  name: string | null;
  ownerName: string | null;
  status: string;
  stale: boolean;
  waitReason: string | null;
  model: string | null;
  startedAt: string;
  costUsd: number | null;
  cwd: string | null;
  git: { repo: string | null; branch: string | null } | null;
  openAsk: { id: string; kind: string; tool: string | null; prompt: string; options: string[]; createdAt: string } | null;
  assignee: { name: string } | null;
  stopRequested: boolean;
  tags: Record<string, string>;
}

const HELP = `tessera ${VERSION} — the Tessera command line

Set up
  tessera login --server https://tessera.example.com [--key tsk_…]
  tessera logout | whoami

The fleet
  tessera sessions [--waiting] [--json]        live sessions
  tessera show <session>                        one session and its open prompt
  tessera watch                                 print sessions as they start waiting

Act on a session (by id, id prefix, or name)
  tessera allow <session>  |  deny <session> [--reason "…"]
  tessera approve <session>  |  reject <session> --feedback "…"
  tessera answer <session> (--option "…" | --text "…")
  tessera message <session> "text…"
  tessera pause <session> [--reason "…"]  |  resume <session>
  tessera stop <session> [--reason "…"]

Spend
  tessera spend [--days 30] [--by team|cost_center|person|repo|ticket|model|tag:<key>] [--json]
  tessera export [--by cost_center] [--sessions] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-o file.csv]

Policy as code
  tessera policy get [-o policy.json]
  tessera policy apply policy.json [--note "…"] [--dry-run]
  tessera policy test --tool Bash [--command "…"] [--path …] [--url …] [--branch …]

Audit
  tessera audit [--limit 20] [--action session.answer]

Environment: TESSERA_URL and TESSERA_API_KEY override the saved login (for CI).
`;

function client(): Client {
  const conf = loadConf();
  if (!conf) throw new Error("not logged in: run `tessera login --server <url>`, or set TESSERA_URL and TESSERA_API_KEY");
  return new Client(conf);
}

const label = (s: Session) => s.name ?? s.git?.repo ?? s.cwd?.split("/").pop() ?? s.id.slice(0, 8);
function state(s: Session): string {
  if (s.status === "ended") return c.dim("ended");
  if (s.stale) return c.dim("silent");
  if (s.status === "waiting" && s.openAsk) return c.amber(`waiting · ${s.openAsk.kind}`);
  if (s.status === "waiting" && s.waitReason && s.waitReason !== "idle") return c.amber(`waiting · ${s.waitReason}`);
  if (s.status === "running") return c.teal("running");
  return c.dim("idle");
}

/** Find a live session by exact id, unique id prefix, or unique name match. */
export function resolve(sessions: Session[], ref: string): Session {
  const exact = sessions.find((s) => s.id === ref);
  if (exact) return exact;
  const byPrefix = sessions.filter((s) => s.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const byName = sessions.filter((s) => label(s).toLowerCase().includes(ref.toLowerCase()));
  if (byPrefix.length + byName.length === 0) throw new Error(`no live session matches "${ref}"`);
  const pool = byPrefix.length ? byPrefix : byName;
  if (pool.length > 1) throw new Error(`"${ref}" matches ${pool.length} sessions: ${pool.slice(0, 5).map((s) => `${s.id.slice(0, 8)} (${label(s)})`).join(", ")}`);
  return pool[0]!;
}

async function live(cl: Client): Promise<Session[]> {
  return (await cl.get<{ sessions: Session[] }>("/fleet/state")).sessions;
}

async function needAsk(cl: Client, ref: string | undefined, kinds: string[]): Promise<{ s: Session; askId: string }> {
  if (!ref) throw new Error("which session?");
  const s = resolve(await live(cl), ref);
  if (!s.openAsk) throw new Error(`${label(s)} is not waiting on a prompt`);
  if (!kinds.includes(s.openAsk.kind)) throw new Error(`${label(s)} is waiting on a ${s.openAsk.kind}, not a ${kinds.join(" or ")}`);
  return { s, askId: s.openAsk.id };
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const out = (s: string) => process.stdout.write(`${s}\n`);

async function cmdPolicy(a: Args): Promise<number> {
  const cl = client();
  const sub = a._[1];
  if (sub === "get") {
    const p = await cl.get<{ version: number; rules: unknown[] }>("/admin/policy");
    const text = `${JSON.stringify({ version: p.version, rules: p.rules }, null, 2)}\n`;
    const file = str(a.flags.o) ?? str(a.flags.output);
    if (file) {
      writeFileSync(file, text);
      out(`wrote version ${p.version} (${p.rules.length} rules) to ${file}`);
    } else process.stdout.write(text);
    return 0;
  }
  if (sub === "apply") {
    const file = a._[2];
    if (!file) throw new Error("tessera policy apply <file>");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { rules?: { id: string; name: string }[] } | { id: string }[];
    const rules = Array.isArray(doc) ? doc : (doc.rules ?? []);
    const cur = await cl.get<{ version: number; rules: { id: string; name: string }[] }>("/admin/policy");
    const before = new Map(cur.rules.map((r) => [r.id, JSON.stringify(r)]));
    const after = new Map(rules.map((r) => [(r as { id: string }).id, JSON.stringify(r)]));
    const added = [...after.keys()].filter((k) => !before.has(k));
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    const order = (m: Map<string, string>, o: Map<string, string>) => [...m.keys()].filter((k) => o.has(k)).join();
    const reordered = order(before, after) !== order(after, before);
    if (!added.length && !removed.length && !changed.length && !reordered) {
      out(`no change: version ${cur.version} already matches ${file}`);
      return 0;
    }
    out(`version ${cur.version} → ${a.flags["dry-run"] ? "(dry run)" : cur.version + 1}: ${c.green(`+${added.length}`)} ${c.red(`-${removed.length}`)} ${c.amber(`~${changed.length}`)}${reordered ? " reordered" : ""}`);
    for (const k of added) out(`  ${c.green("+")} ${k}`);
    for (const k of removed) out(`  ${c.red("-")} ${k}`);
    for (const k of changed) out(`  ${c.amber("~")} ${k}`);
    if (a.flags["dry-run"]) return 0;
    const r = await cl.put<{ version: number }>("/admin/policy", { rules, baseVersion: cur.version, note: str(a.flags.note) ?? `Applied from ${file.split("/").pop()} with the CLI` });
    out(`version ${r.version} is in force`);
    return 0;
  }
  if (sub === "test") {
    const call = { tool: str(a.flags.tool) ?? "Bash", command: str(a.flags.command), path: str(a.flags.path), url: str(a.flags.url), branch: str(a.flags.branch), repo: str(a.flags.repo) };
    const v = await cl.post<{ decision: string; rule: { name: string; reason: string } | null; dryRun: { name: string; effect: string }[] }>("/admin/policy/test", { call });
    const word = v.decision === "deny" ? c.red("DENY") : v.decision === "ask" ? c.amber("ASK") : c.green("ALLOW");
    out(`${word}  ${v.rule ? `${v.rule.name}${v.rule.reason ? ` — ${v.rule.reason}` : ""}` : "no rule matches"}`);
    for (const d of v.dryRun) out(c.dim(`  dry run: ${d.name} would ${d.effect}`));
    return v.decision === "allow" ? 0 : 3;
  }
  throw new Error("tessera policy get|apply|test");
}

export async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv, ["waiting", "json", "sessions", "dry-run", "help", "h", "version"]);
  const cmd = a._[0];
  try {
    if (cmd === "version" || (!cmd && a.flags.version)) {
      out(VERSION);
      return 0;
    }
    if (!cmd || a.flags.help || a.flags.h || cmd === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (cmd === "login") {
      const server = (str(a.flags.server) ?? process.env.TESSERA_URL ?? (await ask("Tessera address: "))).replace(/\/+$/, "");
      const key = str(a.flags.key) ?? (await ask("API key (Account → API keys): "));
      if (!/^https?:\/\//.test(server)) throw new Error("the address must start with https://");
      if (!key.startsWith("tsk_")) throw new Error("an API key starts with tsk_");
      const me = await new Client({ server, key }).get<{ user: { name: string; role: string }; org: { name: string } }>("/auth/me");
      saveConf({ server, key });
      out(`logged in to ${me.org.name} as ${me.user.name} (${me.user.role}); saved to ${confPath()}`);
      return 0;
    }
    if (cmd === "logout") {
      clearConf();
      out("logged out");
      return 0;
    }
    const cl = client();
    switch (cmd) {
      case "whoami": {
        const me = await cl.get<{ user: { name: string; email: string; role: string }; org: { name: string } }>("/auth/me");
        out(`${me.user.name} <${me.user.email}> · ${me.user.role} · ${me.org.name}`);
        return 0;
      }
      case "sessions":
      case "ls": {
        let list = (await live(cl)).filter((s) => s.status !== "ended");
        if (a.flags.waiting) list = list.filter((s) => s.status === "waiting" && (s.openAsk || (s.waitReason && s.waitReason !== "idle")));
        if (a.flags.json) {
          out(JSON.stringify(list, null, 2));
          return 0;
        }
        if (!list.length) {
          out(c.dim(a.flags.waiting ? "nothing is waiting" : "no live sessions"));
          return 0;
        }
        list.sort((x, y) => Number(!!y.openAsk) - Number(!!x.openAsk) || Date.parse(y.startedAt) - Date.parse(x.startedAt));
        out(table(["ID", "SESSION", "PERSON", "STATE", "MODEL", "AGE", "COST"], list.map((s) => [s.id.slice(0, 8), label(s), `${s.ownerName ?? "—"}${s.assignee ? ` → ${s.assignee.name}` : ""}`, state(s), (s.model ?? "—").replace(/^claude-/, ""), ago(s.startedAt), usd(s.costUsd)]), [6]));
        return 0;
      }
      case "show": {
        const s = resolve(await live(cl), a._[1] ?? "");
        out(`${c.bold(label(s))}  ${c.dim(s.id)}`);
        out(`${state(s)} · ${s.ownerName ?? "—"}${s.assignee ? ` → ${s.assignee.name}` : ""} · ${s.model ?? "—"} · ${usd(s.costUsd)} · started ${ago(s.startedAt)} ago`);
        if (s.git?.repo || s.cwd) out(c.dim(`${s.git?.repo ?? s.cwd}${s.git?.branch ? ` @ ${s.git.branch}` : ""}`));
        if (s.stopRequested) out(c.red("stop requested"));
        if (s.openAsk) {
          out("");
          out(c.amber(`${s.openAsk.kind}${s.openAsk.tool ? ` · ${s.openAsk.tool}` : ""} · waiting ${ago(s.openAsk.createdAt)}`));
          out(s.openAsk.prompt);
          if (s.openAsk.options.length) out(c.dim(`options: ${s.openAsk.options.join(" | ")}`));
          const hint = s.openAsk.kind === "permission" ? `tessera allow ${s.id.slice(0, 8)}  ·  tessera deny ${s.id.slice(0, 8)} --reason "…"` : s.openAsk.kind === "plan" ? `tessera approve ${s.id.slice(0, 8)}  ·  tessera reject ${s.id.slice(0, 8)} --feedback "…"` : `tessera answer ${s.id.slice(0, 8)} --text "…"`;
          out(c.dim(hint));
        }
        return 0;
      }
      case "watch": {
        const seen = new Set<string>();
        out(c.dim("watching for sessions that wait on someone (Ctrl-C to stop)…"));
        const show = (list: Session[]) => {
          for (const s of list) {
            const key = s.openAsk ? `${s.id}:${s.openAsk.id}` : null;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out(`${c.amber("●")} ${new Date().toLocaleTimeString()}  ${c.bold(label(s))} ${c.dim(s.id.slice(0, 8))} waits on ${s.assignee?.name ?? s.ownerName ?? "someone"}: ${s.openAsk!.kind}${s.openAsk!.tool ? ` · ${s.openAsk!.tool}` : ""}`);
            out(`  ${s.openAsk!.prompt.split("\n")[0]!.slice(0, 160)}`);
            if (process.stdout.isTTY) process.stdout.write("\x07");
          }
        };
        for await (const m of cl.stream()) {
          if (m.event === "snapshot") show((m.data as { sessions: Session[] }).sessions);
          else if (m.event === "sessions") show(m.data as Session[]);
        }
        return 0;
      }
      case "allow":
      case "deny": {
        const { s, askId } = await needAsk(cl, a._[1], ["permission"]);
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/answer`, { askId, decision: cmd, ...(str(a.flags.reason) ? { text: str(a.flags.reason) } : {}) });
        out(`${cmd === "allow" ? c.green("allowed") : c.red("denied")} ${s.openAsk!.tool ?? "the tool call"} in ${label(s)}`);
        return 0;
      }
      case "approve":
      case "reject": {
        const { s, askId } = await needAsk(cl, a._[1], ["plan"]);
        const feedback = str(a.flags.feedback) ?? str(a.flags.reason);
        if (cmd === "reject" && !feedback) throw new Error('say what should change: --feedback "…"');
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/answer`, { askId, decision: cmd, ...(feedback ? { text: feedback } : {}) });
        out(`${cmd === "approve" ? c.green("plan approved") : c.amber("plan sent back")} in ${label(s)}`);
        return 0;
      }
      case "answer": {
        const { s, askId } = await needAsk(cl, a._[1], ["question"]);
        const option = str(a.flags.option);
        const text = str(a.flags.text);
        if (!option && !text) throw new Error('give --option "…" or --text "…"');
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/answer`, { askId, decision: "answer", ...(option ? { option } : {}), ...(text ? { text } : {}) });
        out(`answered ${label(s)}`);
        return 0;
      }
      case "message": {
        const s = resolve(await live(cl), a._[1] ?? "");
        const text = a._.slice(2).join(" ").trim();
        if (!text) throw new Error('tessera message <session> "text"');
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/message`, { text });
        out(`message queued for ${label(s)}; delivered when it next pauses`);
        return 0;
      }
      case "pause":
      case "resume": {
        const s = resolve(await live(cl), a._[1] ?? "");
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/pause`, { paused: cmd === "pause", ...(str(a.flags.reason) ? { reason: str(a.flags.reason) } : {}) });
        out(`${cmd === "pause" ? "paused" : "resumed"} ${label(s)}`);
        return 0;
      }
      case "stop": {
        const s = resolve(await live(cl), a._[1] ?? "");
        await cl.post(`/fleet/sessions/${encodeURIComponent(s.id)}/stop`, str(a.flags.reason) ? { reason: str(a.flags.reason) } : {});
        out(`stop sent to ${label(s)}; it applies at the next tool call`);
        return 0;
      }
      case "spend": {
        const by = str(a.flags.by) ?? "team";
        const days = Number(str(a.flags.days) ?? 30);
        const r = await cl.get<{ range: { from: string; to: string }; totals: { costUsd: number; prevCostUsd: number; sessions: number; people: number }; groups: { key: string; costUsd: number; sessions: number }[]; forecast: { projectedMonthUsd: number; monthToDateUsd: number } }>(`/analytics?days=${days}&groupBy=${encodeURIComponent(by)}`);
        if (a.flags.json) {
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        const t = r.totals;
        const delta = t.prevCostUsd > 0 ? ` (${t.costUsd >= t.prevCostUsd ? "+" : "−"}${Math.abs(Math.round(((t.costUsd - t.prevCostUsd) / t.prevCostUsd) * 100))}% vs the ${days} days before)` : "";
        out(`${c.bold(usd(t.costUsd))} from ${r.range.from} to ${r.range.to}${delta} · ${t.sessions} sessions · ${t.people} ${t.people === 1 ? "person" : "people"}`);
        out(c.dim(`this month: ${usd(r.forecast.monthToDateUsd)} so far, heading for ${usd(r.forecast.projectedMonthUsd)}`));
        out("");
        out(table([by.toUpperCase(), "SESSIONS", "COST", "SHARE"], r.groups.slice(0, 25).map((g) => [g.key, String(g.sessions), usd(g.costUsd), t.costUsd ? `${Math.round((g.costUsd / t.costUsd) * 100)}%` : ""]), [1, 2, 3]));
        return 0;
      }
      case "export": {
        const q = new URLSearchParams({ groupBy: str(a.flags.by) ?? "cost_center", detail: a.flags.sessions ? "sessions" : "groups" });
        if (str(a.flags.from)) q.set("from", str(a.flags.from)!);
        if (str(a.flags.to)) q.set("to", str(a.flags.to)!);
        if (!q.has("from")) q.set("days", str(a.flags.days) ?? "30");
        const csv = await (await cl.raw("GET", `/analytics/export.csv?${q}`, undefined, "text/csv")).text();
        const file = str(a.flags.o) ?? str(a.flags.output);
        if (file) {
          writeFileSync(file, csv);
          out(`wrote ${csv.trim().split("\n").length - 1} rows to ${file}`);
        } else process.stdout.write(csv);
        return 0;
      }
      case "policy":
        return await cmdPolicy(a);
      case "audit": {
        const q = new URLSearchParams({ limit: str(a.flags.limit) ?? "20" });
        if (str(a.flags.action)) q.set("action", str(a.flags.action)!);
        const r = await cl.get<{ entries: { createdAt: string; actorName: string; action: string; targetType: string | null; targetId: string | null }[] }>(`/admin/audit?${q}`);
        out(table(["WHEN", "WHO", "ACTION", "TARGET"], r.entries.map((e) => [new Date(e.createdAt).toLocaleString(), e.actorName, e.action, e.targetType ? `${e.targetType} ${(e.targetId ?? "").slice(0, 12)}` : ""])));
        return 0;
      }
      default:
        process.stderr.write(`tessera: unknown command "${cmd}"\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    const msg = e instanceof ApiError ? `${e.message}${e.status === 401 ? " (run `tessera login` again)" : ""}` : (e as Error).message;
    process.stderr.write(`tessera: ${msg}\n`);
    return 1;
  }
}
