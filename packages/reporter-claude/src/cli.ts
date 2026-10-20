import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, HOME, VERSION, loadConfig, log, newMachineId, saveConfig, shortHostname } from "./config.js";
import { alive, handle, heartbeat, type HookInput } from "./hooks.js";
import { hasState, updateState } from "./state.js";
import { claudeLoadsMods, disableMod, enableMod, MARKETPLACE_DIR, modInstalled, writeMod } from "./mod.js";
import { get, request, typicalLatencyMs } from "./transport.js";

// Seconds Claude Code gives each hook. A round trip to the server through a corporate proxy can take
// 1.5-2 s, and a report a web filter blocks is sent a second time with detail withheld, so the short
// ones allow for two round trips and a little slack.
const EVENTS: Array<[string, number]> = [
  ["SessionStart", 15],
  ["UserPromptSubmit", 15],
  ["PreToolUse", 660], // a question can wait up to ten minutes for Tessera in away mode; ordinary calls return in seconds
  ["PostToolUse", 15],
  ["PostToolUseFailure", 15],
  ["SubagentStart", 15],
  ["SubagentStop", 15],
  ["Notification", 15],
  ["PermissionRequest", 660], // likewise for a permission prompt or a plan
  ["Stop", 20],
  ["PreCompact", 15],
  ["SessionEnd", 10],
];

/** What the long hooks above are given; the reporter keeps every wait inside it. */
export const LONG_HOOK_SECONDS = 660;

const OURS = /tessera-reporter(?:\.m?js)?\\?"?\s+hook\b/;
type HookEntry = { type: string; command: string; args?: string[]; timeout?: number; shell?: string };
/** Ours in either form: the old shell command "node ... hook X", or exec form with our script as the first argument. */
const isOurs = (h: Partial<HookEntry> | undefined): boolean => !!h && ((!!h.command && OURS.test(h.command)) || (Array.isArray(h.args) && /tessera-reporter(\.m?js)?$/.test(h.args[0] ?? "") && h.args[1] === "hook"));

/** The Node the hooks should run. process.execPath is the resolved binary, which on Homebrew is a versioned Cellar
 *  path that `brew upgrade node` deletes; the installer passes the stable one it found (/opt/homebrew/bin/node). */
function hookNode(): string {
  const n = process.env.TESSERA_NODE;
  try {
    if (n && statSync(n).isFile()) {
      accessSync(n, constants.X_OK);
      return n;
    }
  } catch {
    /* missing or not executable: fall back */
  }
  return process.execPath;
}

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

/** Events that have one of our hooks in a settings file. */
function hooksInstalled(settingsFile: string): string[] {
  try {
    const hooks = (JSON.parse(readFileSync(settingsFile, "utf8")).hooks ?? {}) as Record<string, Array<{ hooks?: HookEntry[] }>>;
    return Object.keys(hooks).filter((ev) => (hooks[ev] ?? []).some((g) => (g.hooks ?? []).some(isOurs)));
  } catch {
    return [];
  }
}

/** Our long hooks (PreToolUse, PermissionRequest) still on the short timeouts of an older install. */
function shortHooks(settingsFile: string): string[] {
  try {
    const hooks = (JSON.parse(readFileSync(settingsFile, "utf8")).hooks ?? {}) as Record<string, Array<{ hooks?: HookEntry[] }>>;
    const out: string[] = [];
    for (const ev of ["PreToolUse", "PermissionRequest"]) for (const g of hooks[ev] ?? []) for (const h of g.hooks ?? []) if (isOurs(h) && (h.timeout ?? 0) < LONG_HOOK_SECONDS) out.push(ev);
    return out;
  } catch {
    return [];
  }
}

/** Our exec-form hooks whose Node or script path no longer exists (a moved checkout, a removed private Node). */
function staleHooks(settingsFile: string): string[] {
  try {
    const hooks = (JSON.parse(readFileSync(settingsFile, "utf8")).hooks ?? {}) as Record<string, Array<{ hooks?: HookEntry[] }>>;
    const out: string[] = [];
    for (const ev of Object.keys(hooks)) for (const g of hooks[ev] ?? []) for (const h of g.hooks ?? []) {
      if (!isOurs(h) || !Array.isArray(h.args)) continue;
      if (!existsSync(h.command) || !existsSync(h.args[0] ?? "")) out.push(ev);
    }
    return out;
  } catch {
    return [];
  }
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

/** A proxy is set in the environment (often the only way out of a corporate network). */
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
/** Node's fetch ignores HTTPS_PROXY unless asked; setGlobalProxyFromEnv exists only in newer Node. */
const canProxy = typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function";

/** `claude --version`, or null when Claude Code is not on PATH. */
function claudeVersion(): string | null {
  try {
    return execFileSync(process.platform === "win32" ? "claude.cmd" : "claude", ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" }).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export async function main(args: string[]): Promise<void> {
  if (PROXY && canProxy) (http as unknown as { setGlobalProxyFromEnv: () => void }).setGlobalProxyFromEnv();
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
        // A sleeping or redeploying server (Render's free plan) can take a minute to answer, so wait for it.
        const slow = setTimeout(() => process.stdout.write(`Waiting for ${server} to answer; a server that was asleep can take up to a minute to wake...\n`), 5000);
        let res: Response;
        try {
          res = await fetch(`${server}/api/enrol/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, label, hostname: shortHostname() }),
            signal: AbortSignal.timeout(90_000),
          });
        } catch (e) {
          if ((e as Error).name !== "TimeoutError") throw e;
          throw new Error(`${server} did not answer the enrolment request within 90 seconds. Check the server is running, then run this again; if it then says the code has expired, get a new one from the Devices page.`);
        } finally {
          clearTimeout(slow);
        }
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
      const hooks = (settings.hooks ??= {}) as Record<string, Array<{ matcher?: string; hooks: HookEntry[] }>>;
      const bin = installBin();
      // Exec form: the Node that is running this installer (by its stable path), spawned directly with our script. No
      // shell on any platform, so quoting, Git Bash and PowerShell never come into it, and a private Node works too.
      const node = hookNode();
      const entry = (ev: string, timeout: number): HookEntry => ({ type: "command", command: node, args: [bin, "hook", ev], timeout });
      let added = 0;
      for (const [ev, timeout] of EVENTS) {
        const list = (hooks[ev] ??= []);
        const has = list.some((g) => g.hooks?.some(isOurs));
        if (has) {
          for (const g of list) g.hooks = (g.hooks ?? []).map((h) => (isOurs(h) ? entry(ev, timeout) : h));
          continue;
        }
        list.push({ hooks: [entry(ev, timeout)] });
        added++;
      }
      // The mod, beside the hooks, for Claude Code 2.1.287 and later. An older Claude Code ignores it,
      // but it is only switched on where it can load, so /plugin does not list a plugin that does nothing.
      let modNote = "";
      if (!args.includes("--no-mod")) {
        const claude = claudeVersion();
        const loads = claudeLoadsMods(claude);
        const version = loads === false ? null : writeMod();
        if (version) {
          enableMod(settings);
          modNote = `Installed the Tessera mod ${version} (${MARKETPLACE_DIR}): messages from Tessera reach an idle session at once, and /tessera sets away mode. Restart Claude Code sessions to load it.\n`;
        } else if (loads === false) {
          disableMod(settings);
          modNote = `Claude Code ${claude} cannot load mods (2.1.287 or later can); the hooks report everything without it.\n`;
        }
      } else disableMod(settings);
      writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
      // Remember the timeouts these hooks now have, so waits (away mode) stay inside them.
      const cfgNow = loadConfig();
      if (cfgNow && cfgNow.hookTimeoutSeconds !== LONG_HOOK_SECONDS) saveConfig({ ...cfgNow, hookTimeoutSeconds: LONG_HOOK_SECONDS });
      process.stdout.write(`${added ? `Added ${added} hook${added > 1 ? "s" : ""}` : "Hooks already present; updated them"} in ${p}.\n${modNote}${loadConfig() ? "Start a Claude Code session; it will appear on your Tessera wall." : "Now run: tessera-reporter enrol --server <url> --code <code>"}\n`);
      return;
    }
    case "uninstall": {
      const p = settingsPath();
      if (!existsSync(p)) return;
      const settings = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks: HookEntry[] }>>;
      for (const ev of Object.keys(hooks)) {
        hooks[ev] = (hooks[ev] ?? []).map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
        if (!hooks[ev]!.length) delete hooks[ev];
      }
      disableMod(settings);
      rmSync(MARKETPLACE_DIR, { recursive: true, force: true });
      writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
      process.stdout.write(`Removed Tessera's hooks and mod from ${p}. Your device token stays in ${CONFIG_PATH}; delete it to forget this machine.\n`);
      return;
    }
    case "keepalive": {
      // Started detached by a hook. Keeps a waiting or busy session on the wall while no hook fires,
      // and exits when Claude Code exits, the session ends, or another keep-alive takes over.
      const sid = args[1] ?? "";
      const claude = Number(args[2]);
      const cfg = loadConfig();
      if (!sid || !cfg || !alive(claude)) return;
      const every = 10_000;
      const until = Date.now() + 24 * 3600_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, every));
        if (Date.now() > until || !alive(claude) || !hasState(sid)) return;
        const st = updateState(sid, null, null, (s) => ({ mine: s.keepalivePid === process.pid, ended: s.status === "ended", quietFor: Date.now() - (s.lastReportAt ?? 0) }));
        if (!st.mine || st.ended) return;
        // Hooks report on their own while Claude Code is busy; only fill the gaps.
        if (st.quietFor >= every) await heartbeat(cfg, sid).catch((e) => log(`keepalive ${sid}: ${(e as Error).message}`));
      }
    }
    case "status": {
      const cfg = loadConfig();
      if (!cfg) {
        process.stdout.write(`Not enrolled. Run: tessera-reporter enrol --server <url> --code <code>\n`);
        return;
      }
      const who = await get<{ device: string; user: string; liveSessions: number }>(cfg, "/api/ingest/whoami", 5000);
      const p = settingsPath();
      const installed = existsSync(p) && hooksInstalled(p).length > 0;
      process.stdout.write(
        `Server: ${cfg.serverUrl}\n${who ? `Device: ${who.device} (${who.user}) · ${who.liveSessions} live session${who.liveSessions === 1 ? "" : "s"} on the wall` : "Server unreachable or token revoked"}\nHooks: ${installed ? `installed in ${p}` : "not installed (run: tessera-reporter install)"}\nState: ${HOME}\n`,
      );
      return;
    }
    case "doctor": {
      // Everything that has to be true for a session to appear and be answerable, checked in order, each with a fix.
      const rows: Array<[boolean | null, string, string?]> = [];
      const major = Number(process.versions.node.split(".")[0]);
      rows.push([major >= 20, `Node ${process.version} at ${process.execPath}`, major >= 20 ? undefined : "Node 20 or newer is needed; rerun the installer, which fetches a private copy."]);
      if (PROXY) rows.push([canProxy, canProxy ? "Using the proxy from HTTPS_PROXY" : `A proxy is set, but Node ${process.version} cannot use it`, canProxy ? undefined : "This Node is too old to send requests through a proxy. Install the current Node from nodejs.org, then rerun the installer."]);
      const cfg = loadConfig();
      rows.push([!!cfg, cfg ? `Enrolled with ${cfg.serverUrl} (${CONFIG_PATH})` : "Not enrolled", cfg ? undefined : "Get an enrolment code on the Devices page and run the installer with --code."]);
      if (cfg) {
        const health = await get<{ ok: boolean }>(cfg, "/api/health", 5000);
        rows.push([!!health?.ok, health?.ok ? "Server reachable" : `Cannot reach ${cfg.serverUrl}`, health?.ok ? undefined : "Check the address, your network, VPN or proxy. The server must be reachable from this machine."]);
        if (health?.ok) {
          const who = await get<{ device: string; user: string }>(cfg, "/api/ingest/whoami", 5000);
          rows.push([!!who, who ? `Device token valid: ${who.device}, enrolled by ${who.user}` : "Device token rejected", who ? undefined : "The token was revoked. Get a new enrolment code and rerun the installer."]);
          const typical = typicalLatencyMs();
          rows.push([typical == null || typical < 2500, typical == null ? "Round trip to the server: not measured yet" : `Round trip to the server: about ${typical} ms`, typical != null && typical >= 2500 ? "A slow network or proxy. The reporter sizes its timeouts to this, but an answer from Tessera can reach the terminal late." : undefined]);
          // A command that looks like shell injection to a web filter. If this is blocked, real reports with command text will be too.
          const probe = await request(cfg, "POST", "/api/ingest/decide", { sessionId: "doctor-probe", tool: "Bash", command: "echo \"== check ==\"; curl -s -w ' [%{http_code}]\\n' http://localhost:8080/health" }, 8000);
          rows.push([probe.kind !== "blocked", probe.kind === "blocked" ? "A web filter on this network blocks some report content" : "Report content passes this network's filters", probe.kind === "blocked" ? `Sessions still appear, with command and file detail withheld whenever a report is blocked. Ask your network team to allow POSTs to ${cfg.serverUrl}.` : undefined]);
        }
      }
      const p = settingsPath();
      const ours = existsSync(p) ? hooksInstalled(p) : [];
      const missing = EVENTS.map(([ev]) => ev).filter((ev) => !ours.includes(ev));
      rows.push([missing.length === 0, missing.length === 0 ? `All ${EVENTS.length} hooks in ${p}` : `${missing.length} hook${missing.length > 1 ? "s" : ""} missing in ${p}: ${missing.join(", ")}`, missing.length ? "Run: tessera-reporter install" : undefined]);
      const short = existsSync(p) ? shortHooks(p) : [];
      if (short.length) rows.push([null, `Hooks from an older install: prompts wait at most ${(cfg?.hookTimeoutSeconds ?? 90) - 30} s for Tessera, so Away mode cannot hold them longer`, "Run the installer line again to update the hooks"]);
      const stale = existsSync(p) ? staleHooks(p) : [];
      if (stale.length) rows.push([false, `${stale.length} hook${stale.length > 1 ? "s" : ""} point at a Node or script that no longer exists`, "Run: tessera-reporter install"]);
      const claude = claudeVersion();
      rows.push([claude ? true : null, claude ? `Claude Code ${claude}` : "Claude Code not found on PATH (fine if it runs from elsewhere)"]);
      const loads = claudeLoadsMods(claude);
      let settingsNow: Record<string, unknown> = {};
      try {
        if (existsSync(p)) settingsNow = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      } catch {
        rows.push([false, `${p} is not valid JSON`, "Fix or remove the file, then run: tessera-reporter install"]);
      }
      const hasMod = modInstalled(settingsNow);
      if (loads === false) rows.push([null, "The Tessera mod needs Claude Code 2.1.287 or later; the hooks report everything without it"]);
      else rows.push([hasMod ? true : null, hasMod ? `Tessera mod installed (${MARKETPLACE_DIR})` : "Tessera mod not installed: messages from Tessera wait for the end of the next turn", hasMod ? undefined : "Run: tessera-reporter install"]);
      let bad = 0;
      for (const [ok, text, fix] of rows) {
        if (ok === false) bad++;
        process.stdout.write(`${ok === true ? "ok " : ok === false ? "FAIL" : "-- "} ${text}\n${fix ? `     → ${fix}\n` : ""}`);
      }
      process.stdout.write(bad ? `\n${bad} problem${bad > 1 ? "s" : ""} to fix.\n` : "\nEverything looks right. Start a Claude Code session and watch the wall.\n");
      process.exitCode = bad ? 1 : 0;
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
  install [--no-mod]
               Add Tessera's hooks to Claude Code's settings.json, and the Tessera mod
               for Claude Code 2.1.287 and later (--no-mod: hooks only).
  uninstall    Remove them again.
  status       Show the connection from this machine's side.
  doctor       Check Node, enrolment, the server, the token and the hooks; say what to fix.
  hook <event> Used by Claude Code; reads the event from stdin.
`);
  }
}
