// Test helper: a CLI that prints `n` bytes through runCli, to check nothing is cut off when stdout is a pipe.
import { runCli } from "../../src/lib/cli.js";

const n = Number(process.argv[2]);
await runCli(async () => {
  process.stdout.write(`${"x".repeat(n - 1)}\n`);
  return 0;
});
