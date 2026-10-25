import { defineConfig } from "vitest/config";

// CLI tests spawn a process each; 5 s is too tight when several suites run at once (the gatekeeper-cli timeouts under load).
// Coverage (v8) counts the library and every task, entry points included: a CLI's `main` is exported and tested in-process, and the
// child-process tests do not count. Branches is not at 80 yet: its threshold is the floor reached, so it can only go up.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "tasks/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**", "tasks/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "lcov", "json-summary"],
      thresholds: { statements: 80, functions: 80, lines: 80, branches: 75 },
    },
  },
});
