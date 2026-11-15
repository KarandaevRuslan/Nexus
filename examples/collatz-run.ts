import { collatz } from "./collatz";

for (const n of [1, 3, 6, 7, 27, 3]) {
  const { steps, chain } = collatz(n);
  console.log(`${n}: ${steps} steps; ${chain.map(String).join(" → ")}`);
}

// JavaScript numbers stop being exact above Number.MAX_SAFE_INTEGER.
// A bigint preserves arbitrary integer precision.
const huge = collatz(2n ** 60n);
console.log(`2^60: ${huge.steps} steps, ${huge.chain.length} terms`);
