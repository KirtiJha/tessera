#!/usr/bin/env node
import("../dist/main.js").then((m) => m.run(process.argv.slice(2))).then((code) => process.exit(code ?? 0)).catch((e) => {
  process.stderr.write(`tessera: ${e?.message ?? e}\n`);
  process.exit(1);
});
