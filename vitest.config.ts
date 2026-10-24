import { defineConfig } from "vitest/config";

// CLI tests spawn a process each; 5 s is too tight when several suites run at once (the gatekeeper-cli timeouts under load).
export default defineConfig({ test: { include: ["test/**/*.test.ts", "tasks/**/*.test.ts"], testTimeout: 20_000 } });
