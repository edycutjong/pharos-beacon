// Test helper: one run of an agent that takes a lock (tests only).
//   tsx lock-child.ts <state file> hold <holders dir> <start at ms>  → waits for the start time, holds the lock 150 ms,
//                                                                      prints "max <n>" (most holders seen) or "held"
//   tsx lock-child.ts <state file> exit                              → takes the lock, then process.exit(130) inside it
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../src/lib/state.js";

const [file, mode, holders, startAt] = process.argv.slice(2);
if (mode === "exit") {
  await withLock(file, async () => process.exit(130));
} else {
  await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
  try {
    await withLock(file, async () => {
      const me = join(holders, String(process.pid));
      writeFileSync(me, "");
      await new Promise((r) => setTimeout(r, 150));
      const n = readdirSync(holders).length;
      rmSync(me);
      console.log(`max ${n}`);
    });
  } catch (e) {
    console.log(/held by another run|being taken over/.test((e as Error).message) ? "held" : `error ${(e as Error).message}`);
  }
}
