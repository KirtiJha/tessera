import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";
import { EMBEDDED_MOD } from "./modfiles.js";

/**
 * The Tessera mod runs inside Claude Code 2.1.287 and later, beside the hooks.
 * It is installed as a plugin from a marketplace directory under ~/.tessera,
 * which Claude Code loads in place, so updating the files updates the mod.
 */
export const MARKETPLACE = "tessera";
export const PLUGIN_ID = `tessera@${MARKETPLACE}`;
export const MARKETPLACE_DIR = join(HOME, "claude-plugins");
export const MOD_DIR = join(MARKETPLACE_DIR, "tessera");
/** The first Claude Code that loads mods. */
export const MIN_CLAUDE = [2, 1, 287] as const;

/** The mod's files from a source checkout, skipping its tests and the types Claude Code writes beside it. */
function checkoutFiles(): Record<string, string> | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "mod-claude", "plugin");
  if (!existsSync(root)) return null;
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p).split("\\").join("/");
      if (rel === "tests" || rel === ".claude-plugin/types" || rel === "tsconfig.json") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

export function modFiles(): Record<string, string> | null {
  return EMBEDDED_MOD ?? checkoutFiles();
}

/** Is this `claude --version` output a release that loads mods? */
export function claudeLoadsMods(versionOutput: string | null): boolean | null {
  const m = versionOutput ? /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput) : null;
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_CLAUDE[i]) return v[i]! > MIN_CLAUDE[i]!;
  return true;
}

/** Write the marketplace and the mod. Returns the mod's version, or null when this build carries no mod. */
export function writeMod(): string | null {
  const files = modFiles();
  if (!files || !files["hooks/register.js"] || !files[".claude-plugin/plugin.json"]) return null;
  rmSync(MOD_DIR, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(MOD_DIR, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const manifest = JSON.parse(files[".claude-plugin/plugin.json"]) as { version?: string; description?: string };
  mkdirSync(join(MARKETPLACE_DIR, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(MARKETPLACE_DIR, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: MARKETPLACE, owner: { name: "Tessera" }, plugins: [{ name: "tessera", source: "./tessera", description: manifest.description ?? "Tessera inside Claude Code" }] }, null, 2) + "\n",
  );
  mkdirSync(join(HOME, "live"), { recursive: true, mode: 0o700 });
  return manifest.version ?? "0.0.0";
}

type Settings = Record<string, unknown> & {
  extraKnownMarketplaces?: Record<string, unknown>;
  enabledPlugins?: Record<string, boolean>;
};

/** Point Claude Code's user settings at the marketplace and turn the mod on. Changes `settings` in place. */
export function enableMod(settings: Settings): void {
  settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces ?? {}), [MARKETPLACE]: { source: { source: "directory", path: MARKETPLACE_DIR } } };
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [PLUGIN_ID]: true };
}

/** Take the mod out of Claude Code's user settings. Changes `settings` in place. */
export function disableMod(settings: Settings): void {
  if (settings.enabledPlugins) {
    delete settings.enabledPlugins[PLUGIN_ID];
    if (!Object.keys(settings.enabledPlugins).length) delete settings.enabledPlugins;
  }
  if (settings.extraKnownMarketplaces) {
    delete settings.extraKnownMarketplaces[MARKETPLACE];
    if (!Object.keys(settings.extraKnownMarketplaces).length) delete settings.extraKnownMarketplaces;
  }
}

/** Is the mod on in these settings, with its files in place? */
export function modInstalled(settings: Settings): boolean {
  return settings.enabledPlugins?.[PLUGIN_ID] === true && !!settings.extraKnownMarketplaces?.[MARKETPLACE] && existsSync(join(MOD_DIR, "hooks", "register.js"));
}
