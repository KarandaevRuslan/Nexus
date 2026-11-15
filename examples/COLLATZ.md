# Collatz as a reactive Nexus pipeline

This is a **working example against Nexus v0.1.17**, not a framework release.
The core implementation in `src/` is unchanged.

## Run

```bash
npm run collatz-demo
npm test
```

## Public function

```typescript
import { collatz, createCollatzCalculator } from "./examples/collatz";

const first = collatz(3);
// first.chain: [3n, 10n, 5n, 16n, 8n, 4n, 2n, 1n]
// first.steps: 7

const second = collatz(6); // same Dispatcher and Handler, reset automatically

const custom = createCollatzCalculator(1000);
custom(27);  // 111 steps
custom(1);   // 0 steps

// Preserve exact integers beyond JS Number.MAX_SAFE_INTEGER:
collatz(2n ** 60n); // 60 steps
```

## What the framework actually does

1. `collatz(n)` begins an **inline transaction**, replacing the working Store with the new input.
2. The change to that Store triggers `CollatzStep` via `on.any`.
3. `when(ReadContext)` checks whether the sequence has reached 1 and remains within the step limit.
4. `run(Context)` computes one Collatz transition and commits a **new immutable state** to the Store.
5. That Commit triggers the next step. Each step receives a fresh snapshot.
6. After synchronous propagation ends, the function walks the immutable linked history, returns the complete chain and the step count.

Each Collatz step is performed by a separate Handler execution and Commit. The Handler itself contains **no loop**. The only loop is used to materialize the resulting chain into a normal array.

The history uses a **frozen persistent linked list** in a `storage: "reference"` Store. Because all nodes are created by this module and permanently frozen, previous snapshots remain stable; each step allocates one node rather than copying the entire history array. BigInt arithmetic avoids precision loss.

## Limits

- The Collatz conjecture is unproved, so termination for every positive integer cannot be guaranteed mathematically.
- By default, a calculation throws after **10,000 transitions** without reaching 1; pass a different limit to `createCollatzCalculator(maxSteps)`.
- A JavaScript `number` input must be a positive safe integer; use `bigint` for arbitrary integer precision.
- This is a *synchronous* calculation and deliberately increases `maxInlineWaves` and `maxCausalWaves` to accommodate the selected limit. Large chains can still occupy the JS thread for a long time; for long-running workloads a deferred/streaming variant is preferable.
- In `storage: "reference"`, Nexus does not enforce immutability. This example enforces it itself with `Object.freeze` and retains the Store only in a private closure.
