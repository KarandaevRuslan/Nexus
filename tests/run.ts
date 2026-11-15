declare const process: { exitCode: number };

import { coreCases } from "./core.spec";
import { fridaCases } from "./frida.spec";
import { snapshotCases } from "./snapshots.spec";
import { conflictCases } from "./conflicts.spec";
import { schedulerCases } from "./scheduler.spec";
import { contractCases } from "./contracts.spec";
import { recoveryCases } from "./recovery.spec";
import { v017Cases } from "./v017.spec";
import { collatzCases } from "./collatz.spec";
import { collatzGraphCases } from "./collatz-graph.spec";
import { collatzVisualizationCases } from "./collatz-graph-visualization.spec";
import { v018Cases } from "./v018.spec";
import { v019Cases } from "./v019.spec";
import { v0110Cases } from "./v0110.spec";
import { v0111Cases } from "./v0111.spec";
import { v0112Cases } from "./v0112.spec";
import { v0113Cases } from "./v0113.spec";
import { v0114Cases } from "./v0114.spec";
import { v0115Cases } from "./v0115.spec";
import { v0116Cases } from "./v0116.spec";
import { v0117Cases } from "./v0117.spec";
import { v0118Cases } from "./v0118.spec";

// Keep the original ordering of the 15 v0.1 regression tests.
const suites = [
  ...coreCases.slice(0, 9),
  ...fridaCases,
  ...coreCases.slice(9),
  ...snapshotCases,
  ...conflictCases,
  ...schedulerCases,
  ...contractCases,
  ...recoveryCases,
  ...v017Cases,
  ...v018Cases,
  ...v019Cases,
  ...v0110Cases,
  ...v0111Cases,
  ...v0112Cases,
  ...v0113Cases,
  ...v0114Cases,
  ...v0115Cases,
  ...v0116Cases,
  ...v0117Cases,
  ...collatzCases,
  ...collatzGraphCases,
  ...collatzVisualizationCases,
  ...v0118Cases,
];

async function main(): Promise<void> {
  for (const [name, fn] of suites) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      throw error;
    }
  }
  console.log(`PASS ${suites.length} tests`);
}
void main().catch(() => { process.exitCode = 1; });
