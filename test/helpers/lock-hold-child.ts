// Test helper: takes a lock, says LOCKED, and holds it for 30 s (tests only).
import { withLock } from "../../src/lib/state.js";

await withLock(process.argv[2], async () => {
  console.log("LOCKED");
  await new Promise((r) => setTimeout(r, 30_000));
});
