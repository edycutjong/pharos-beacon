#!/usr/bin/env node
// `pharos-docs "<question>"`: the Doc-Search CLI. Runs the TypeScript source through tsx (a dev dependency).
import { register } from "tsx/esm/api";
register();
const { runCli } = await import("../src/lib/cli.ts");
const { main } = await import("../tasks/doc-search-cli/index.ts");
await runCli(main);
