// Bundles the reporter into one file with no dependencies and packs it as an
// npm tarball (release/tessera-reporter.tgz). Every Tessera server serves that
// tarball at /downloads/tessera-reporter.tgz, so machines install the reporter
// from their own server: no npm registry, and always the matching version.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const pkgDir = join(out, "pkg");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

// The Tessera mod rides inside the reporter: install writes it out beside the hooks.
const modRoot = join(root, "..", "mod-claude", "plugin");
const modFiles = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(modRoot, p).split("\\").join("/");
    if (rel === "tests" || rel === ".claude-plugin/types" || rel === "tsconfig.json") continue;
    if (statSync(p).isDirectory()) walk(p);
    else modFiles[rel] = readFileSync(p, "utf8");
  }
})(modRoot);
if (!modFiles["hooks/register.js"]) throw new Error(`the mod is missing from ${modRoot}`);
const embedMod = {
  name: "embed-mod",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]modfiles\.ts$/ }, () => ({ contents: `export const EMBEDDED_MOD = ${JSON.stringify(modFiles)};`, loader: "ts" }));
  },
};

await build({
  entryPoints: [join(root, "src/entry.ts")],
  outfile: join(pkgDir, "tessera-reporter.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  plugins: [embedMod],
});

writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: "tessera-reporter",
      version,
      description: "Tessera reporter for Claude Code. Reports sessions to your Tessera console through Claude Code hooks.",
      license: "Apache-2.0",
      type: "module",
      bin: { "tessera-reporter": "tessera-reporter.mjs" },
      files: ["tessera-reporter.mjs"],
      engines: { node: ">=20" },
    },
    null,
    2,
  ) + "\n",
);

const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: pkgDir, encoding: "utf8" }).trim().split("\n").pop();
renameSync(join(out, file), join(out, "tessera-reporter.tgz"));
// The single file too: the one-line installers fetch it directly, no npm or tar needed on the machine.
copyFileSync(join(pkgDir, "tessera-reporter.mjs"), join(out, "tessera-reporter.mjs"));
console.log(`packed release/tessera-reporter.tgz and tessera-reporter.mjs (v${version})`);
