import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, HOME, VERSION, loadConfig, log, newMachineId, saveConfig, shortHostname } from "./config.js";
import { handle, type HookInput } from "./hooks.js";
import { get } from "./transport.js";

const EVENTS: Array<[string, number]> = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 5],
  ["PreToolUse", 60], // long enough to answer a question from Tessera; ordinary calls return in well under a second
  ["PostToolUse", 5],
  ["PostToolUseFailure", 5],
  ["SubagentStart", 5],
  ["SubagentStop", 5],
  ["Notification", 5],
  ["PermissionRequest", 90],
  ["Stop", 10],
  ["PreCompact", 5],
  ["SessionEnd", 5],
];

const OURS = /tessera-reporter(?:\.m?js)?\\?"?\s+hook\b/;
const isOurs = (cmd: string | undefined): boolean => !!cmd && OURS.test(cmd);

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

/**
 * The script the hooks should run. When we are the bundled single-file reporter
 * (installed with npx from a Tessera server), copy ourselves to ~/.tessera/bin
 * so the hooks survive npx clearing its cache. From a source checkout, point at
 * the checkout's bin.
 */
function installBin(): string {
  const self = fileURLToPath(import.meta.url);
  if (basename(self) === "tessera-reporter.mjs") {
    const dest = join(HOME, "bin", "tessera-reporter.mjs");
    if (resolve(self) !== resolve(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(self, dest);
      chmodSync(dest, 0o755);
    }
    return dest;
  }
  return resolve(dirname(self), "..", "bin", "tessera-reporter.js");
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", () => res(data));
    setTimeout(() => res(data), 3000);
  });
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<void> {
  const cmd = args[0];
  switch (cmd) {
    case "hook": {
      const event = args[1] ?? "";
      const raw = await readStdin();
      let input: HookInput = { session_id: "" };
      try {
        input = JSON.parse(raw || "{}") as HookInput;
      } catch {
        log(`hook ${event}: bad JSON on stdin`);
      }
      const cfg = loadConfig();
      const { output, exitCode } = await handle(cfg, event, input);
      if (output !== undefined) process.stdout.write(JSON.stringify(output));
      process.exitCode = exitCode;
      return;
    }
    case "enrol": {
      const server = (arg(args, "--server") ?? process.env.TESSERA_SERVER ?? "").replace(/\/+$/, "");
      const code = arg(args, "--code");
      const token = arg(args, "--token");
      const label = arg(args, "--label") ?? shortHostname();
      if (!server) throw new Error("--server <url> is required");
      let finalToken = token;
      if (!finalToken) {
        if (!code) throw new Error("give --code <enrolment code> from the Devices page, or --token <device token>");
        const res = await fetch(`${server}/api/enrol/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, label, hostname: shortHostname() }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json()) as { token?: string; error?: string; user?: string };
        if (!res.ok || !body.token) throw new Error(body.error ?? `enrolment failed (${res.status})`);
        finalToken = body.token;
        process.stdout.write(`Enrolled as ${body.user ?? "you"}.\n`);
      }
      const existing = loadConfig();
      saveConfig({ serverUrl: server, token: finalToken, label, machineId: existing?.machineId ?? newMachineId(), excerpts: existing?.excerpts ?? true, permissionWaitSeconds: existing?.permissionWaitSeconds ?? 55, questionWaitSeconds: existing?.questionWaitSeconds ?? 20 });
      const who = await get<{ device: string; user: string; liveSessions: number }>({ serverUrl: server, token: finalToken, label, machineId: "", excerpts: true, permissionWaitSeconds: 55, questionWaitSeconds: 20 }, "/api/ingest/whoami", 5000);
      process.stdout.write(who ? `Connected to ${server} as ${who.user} (device "${who.device}"). Config saved to ${CONFIG_PATH}.\nNext: tessera-reporter install\n` : `Token saved to ${CONFIG_PATH}, but ${server} did not answer /api/ingest/whoami. Check the URL.\n`);
      return;
    }
    case "install": {
      const p = settingsPath();
      mkdirSync(dirname(p), { recursive: true });
      const settings: Record<string, unknown> = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
      const hooks = (settings.hooks ??= {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
      const bin = installBin();
      let added = 0;
      for (const [ev, timeout] of EVENTS) {
        const list = (hooks[ev] ??= []);
        const has = list.some((g) => g.hooks?.some((h) => isOurs(h.command)));
        if (has) {
          for (const g of list) for (const h of g.hooks ?? []) if (isOurs(h.command)) { h.command = `node "${bin}" hook ${ev}`; h.timeout = timeout; }
          continue;
        }
        list.push({ hooks: [{ type: "command", command: `node "${bin}" hook ${ev}`, timeout }] });
        added++;
      }
      writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
      process.stdout.write(`${added ? `Added ${added} hook${added > 1 ? "s" : ""}` : "Hooks already present; updated the command path"} in ${p}.\n${loadConfig() ? "Start a Claude Code session; it will appear on your Tessera wall." : "Now run: tessera-reporter enrol --server <url> --code <code>"}\n`);
      return;
    }
    case "uninstall": {
      const p = settingsPath();
      if (!existsSync(p)) return;
      const settings = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      for (const ev of Object.keys(hooks)) {
        hooks[ev] = (hooks[ev] ?? []).map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) })).filter((g) => g.hooks.length);
        if (!hooks[ev]!.length) delete hooks[ev];
      }
      writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
      process.stdout.write(`Removed Tessera hooks from ${p}. Your device token stays in ${CONFIG_PATH}; delete it to forget this machine.\n`);
      return;
    }
    case "status": {
      const cfg = loadConfig();
      if (!cfg) {
        process.stdout.write(`Not enrolled. Run: tessera-reporter enrol --server <url> --code <code>\n`);
        return;
      }
      const who = await get<{ device: string; user: string; liveSessions: number }>(cfg, "/api/ingest/whoami", 5000);
      const p = settingsPath();
      const installed = existsSync(p) && OURS.test(readFileSync(p, "utf8"));
      process.stdout.write(
        `Server: ${cfg.serverUrl}\n${who ? `Device: ${who.device} (${who.user}) · ${who.liveSessions} live session${who.liveSessions === 1 ? "" : "s"} on the wall` : "Server unreachable or token revoked"}\nHooks: ${installed ? `installed in ${p}` : "not installed (run: tessera-reporter install)"}\nState: ${HOME}\n`,
      );
      return;
    }
    case "version":
    case "--version":
      process.stdout.write(`tessera-reporter ${VERSION}\n`);
      return;
    default:
      process.stdout.write(`tessera-reporter ${VERSION}

  enrol --server <url> (--code <code> | --token <token>) [--label <name>]
        Register this machine with your Tessera server.
  install      Add Tessera's hooks to Claude Code's settings.json.
  uninstall    Remove them again.
  status       Show the connection from this machine's side.
  hook <event> Used by Claude Code; reads the event from stdin.
`);
  }
}
