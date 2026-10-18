#!/usr/bin/env node
import("../dist/cli.js").then((m) => m.main(process.argv.slice(2))).catch((e) => {
  process.stderr.write(`tessera-reporter: ${e?.message ?? e}\n`);
  process.exit(1);
});
