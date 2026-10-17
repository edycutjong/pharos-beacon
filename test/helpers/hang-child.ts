// Test helper: a main that never settles and ignores the cleanup, while keeping the event loop busy. A signal must
// still end it within about 2 s (tests only).
import { runCli } from "../../src/lib/cli.js";

await runCli(async () => {
  console.log("READY");
  await new Promise(() => setInterval(() => {}, 1_000));
});
