/**
 * Reusable Collatz (3n + 1) calculator, driven by Nexus Store changes.
 *
 * Every step is a separate atomic Commit; the next step is triggered by
 * the preceding Commit. The trajectory is a persistent, frozen linked list.
 * Reference storage is safe here because every node/state is frozen and is
 * created exclusively by this module. It avoids O(steps^2) array copies.
 */
import { Context, Dispatcher, Handler } from "../src/core";
import type { ReadContext } from "../src/core";

export interface CollatzResult {
  readonly start: bigint;
  readonly chain: readonly bigint[];
  readonly steps: number;
}

type Link = Readonly<{
  value: bigint;
  previous: Link | null;
}>;

type State = Readonly<{
  head: Link;
  steps: number;
}>;

function makeState(value: bigint): State {
  return Object.freeze({
    head: Object.freeze({ value, previous: null }) as Link,
    steps: 0,
  });
}

function normalizeNatural(value: number | bigint): bigint {
  if (typeof value === "bigint") {
    if (value < 1n) throw new RangeError("Input must be a positive integer");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Input must be a positive safe integer; use bigint for larger numbers");
  }
  return BigInt(value);
}

/** Make a reusable calculator. One Dispatcher and one Handler serve every call. */
export function createCollatzCalculator(maxSteps = 10_000): (input: number | bigint) => CollatzResult {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > Number.MAX_SAFE_INTEGER - 3) {
    throw new RangeError("maxSteps must be a positive safe integer");
  }

  const dispatcher = new Dispatcher({
    maxInlineWaves: maxSteps + 2,
    maxCausalWaves: maxSteps + 2,
  });
  const state = dispatcher.store<State>(makeState(1n), { storage: "reference" });

  class CollatzStep extends Handler {
    constructor() {
      super({ on: { any: [state] }, execution: "inline", delivery: "each" });
    }

    override when(ctx: ReadContext): boolean {
      const current = ctx.read(state);
      return current.head.value !== 1n && current.steps < maxSteps;
    }

    override run(ctx: Context): void {
      const previous = ctx.read(state);
      const n = previous.head.value;
      const next = n % 2n === 0n ? n / 2n : 3n * n + 1n;
      const head: Link = Object.freeze({ value: next, previous: previous.head });
      ctx.set(state, Object.freeze({ head, steps: previous.steps + 1 }));
    }
  }

  dispatcher.register(new CollatzStep());

  return (input: number | bigint): CollatzResult => {
    const start = normalizeNatural(input);
    // A fresh state object always emits a changed notification, even if the
    // previous invocation ended at the same number. The Handler advances the
    // sequence synchronously until 1 or the configured step budget is reached.
    dispatcher.inline(ctx => ctx.set(state, makeState(start)));

    return dispatcher.inline(ctx => {
      const final = ctx.read(state);
      if (final.head.value !== 1n) {
        throw new RangeError(`Sequence for ${start} did not reach 1 within ${maxSteps} steps`);
      }
      const reversed: bigint[] = [];
      for (let link: Link | null = final.head; link !== null; link = link.previous) {
        reversed.push(link.value);
      }
      reversed.reverse();
      return { start, chain: reversed, steps: final.steps };
    });
  };
}

/** Ready-to-use function; safe to call repeatedly with different inputs. */
export const collatz = createCollatzCalculator();
