// Test helper: a CLI that prints `n` bytes to stdout (or stderr with "err") through runCli, to check nothing is cut
// off when the stream is a pipe (tests only).
import { runCli } from "../../src/lib/cli.js";

const n = Number(process.argv[2]);
const stream = process.argv[3] === "err" ? process.stderr : process.stdout;
await runCli(async () => {
  stream.write(`${"x".repeat(n - 1)}\n`);
  return 0;
});
