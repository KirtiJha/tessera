// Runs the mod's tests and its static check with Claude Code's own runner,
// which is the only one that knows the mods API. Where Claude Code is not
// installed (a CI image) there is nothing that can run them: say so plainly.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const claude = process.platform === "win32" ? "claude.cmd" : "claude";
try {
  execFileSync(claude, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
} catch {
  console.log("mod-claude: Claude Code is not on PATH, so the mod's tests did not run. Run `pnpm --filter @tessera/mod-claude test` on a machine with Claude Code 2.1.287 or later.");
  process.exit(0);
}
execFileSync(claude, ["plugin", "validate", plugin, "--strict"], { stdio: "inherit", shell: process.platform === "win32" });
execFileSync(claude, ["plugin", "test"], { cwd: plugin, stdio: "inherit", shell: process.platform === "win32" });
