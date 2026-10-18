// Bundles the CLI into one file with no dependencies and packs it as an npm
// tarball (release/tessera-cli.tgz). Every Tessera server serves it at
// /downloads/tessera-cli.tgz, so `npx -y --package=<server>/downloads/tessera-cli.tgz tessera`
// works without an npm registry and always matches the server's version.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const pkgDir = join(out, "pkg");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

await build({
  entryPoints: [join(root, "src/entry.ts")],
  outfile: join(pkgDir, "tessera.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});

writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: "tessera-cli",
      version,
      description: "tessera: the Tessera command line.",
      license: "Apache-2.0",
      type: "module",
      bin: { tessera: "tessera.mjs" },
      files: ["tessera.mjs"],
      engines: { node: ">=20" },
    },
    null,
    2,
  ) + "\n",
);

const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: pkgDir, encoding: "utf8" }).trim().split("\n").pop();
renameSync(join(out, file), join(out, "tessera-cli.tgz"));
console.log(`packed release/tessera-cli.tgz (v${version})`);
