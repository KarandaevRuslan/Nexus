/** Pseudorandom, deterministic by inputs. No global PRNG or wall-clock dependency. */
export function randomIndex(max: number, seed: number, ...values: readonly number[]): number {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("max must be positive");
  let x = (seed | 0) ^ 0x6D2B79F5;
  for (const value of values) {
    x = Math.imul(x ^ (value | 0), 0x85ebca6b);
    x ^= x >>> 13;
  }
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  return (x >>> 0) % max;
}

export function thinkDuration(seed: number, id: number, completedMeals: number, eatMs: number): number {
  const minMs = 80;
  const span = Math.max(1, 2 * eatMs - minMs);
  return minMs + randomIndex(span, seed, id, completedMeals, 917);
}
