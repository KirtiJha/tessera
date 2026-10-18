// Entry point for the bundled, dependency-free reporter (release/tessera-reporter.mjs).
import { main } from "./cli.js";

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`tessera-reporter: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
