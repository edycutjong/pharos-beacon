// Test helper: appends observations to a trend history in a tight loop, saying WROTE <n> after each save, until killed.
import { addObservation, loadTrend, saveTrend, type MetricSpec } from "../../src/trend/watch.js";

const file = process.argv[2]!;
const spec: MetricSpec = { kind: "basefee", network: "atlantic" };
for (let n = 1; ; n++) {
  const r = addObservation(loadTrend(file, spec), { block: String(n), value: String(n), at: new Date().toISOString() });
  saveTrend(file, r.state);
  console.log(`WROTE ${n}`);
}
