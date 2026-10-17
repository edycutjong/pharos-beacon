// Test helper: prints what env.ts resolved (key as a short fingerprint only, never the key) and whether the key
// reached process.env from a file (tests only).
import { createHash } from "node:crypto";
import { envOr, secret } from "../../src/lib/env.js";

const key = secret("PRIVATE_KEY");
console.log(
  JSON.stringify({
    url: envOr("BEACON_T_URL", "DEFAULT"),
    key: key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null,
    keyInProcessEnv: "PRIVATE_KEY" in process.env,
  }),
);
