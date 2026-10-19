import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";

export interface Config {
  serverUrl: string;
  token: string;
  label: string;
  machineId: string;
  /** Send the first 400 characters of each agent's task and answer. */
  excerpts: boolean;
  /** How long a permission prompt waits for an answer from Tessera before falling back to the terminal, seconds. */
  permissionWaitSeconds: number;
  /** How long a multiple-choice question waits for an answer from Tessera before the terminal asks, seconds. */
  questionWaitSeconds: number;
  /** The timeout the installer gave the PreToolUse and PermissionRequest hooks; a wait must end before it. Absent on older installs. */
  hookTimeoutSeconds?: number;
}

export const HOME = process.env.TESSERA_HOME ?? join(homedir(), ".tessera");
export const CONFIG_PATH = join(HOME, "config.json");
export const SESSIONS_DIR = join(HOME, "sessions");
export const LOG_PATH = join(HOME, "reporter.log");

export function ensureDirs(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    if (!raw.serverUrl || !raw.token) return null;
    return {
      serverUrl: raw.serverUrl.replace(/\/+$/, ""),
      token: raw.token,
      label: raw.label ?? hostname(),
      machineId: raw.machineId ?? newMachineId(),
      excerpts: raw.excerpts ?? true,
      permissionWaitSeconds: raw.permissionWaitSeconds ?? 55,
      questionWaitSeconds: raw.questionWaitSeconds ?? 20,
      ...(raw.hookTimeoutSeconds ? { hookTimeoutSeconds: raw.hookTimeoutSeconds } : {}),
    };
  } catch {
    return null;
  }
}

export function saveConfig(c: Config): void {
  ensureDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

export function newMachineId(): string {
  return randomBytes(6).toString("hex");
}

export function shortHostname(): string {
  return hostname().split(".")[0] ?? "unknown";
}

export function log(line: string): void {
  try {
    ensureDirs();
    writeFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  } catch {
    /* never fail a hook over a log line */
  }
}
