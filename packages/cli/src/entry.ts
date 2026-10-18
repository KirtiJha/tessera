import { run } from "./main.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`tessera: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
