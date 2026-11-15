import { collatz, createCollatzCalculator } from "../examples/collatz";
import { eq, ok, throws } from "./helpers";

export const collatzCases: Array<[string, () => void]> = [
  ["Collatz of 1 is a one-term sequence with zero steps", () => {
    const result = collatz(1);
    eq(result.steps, 0);
    eq(result.chain.map(String).join(","), "1");
  }],
  ["Collatz of 3 has the exact full chain", () => {
    const result = collatz(3);
    eq(result.steps, 7);
    eq(result.chain.map(String).join(","), "3,10,5,16,8,4,2,1");
  }],
  ["Collatz of 6 has eight steps", () => {
    const result = collatz(6);
    eq(result.steps, 8);
    eq(result.chain.map(String).join(","), "6,3,10,5,16,8,4,2,1");
  }],
  ["Collatz of 7 has sixteen steps", () => {
    const result = collatz(7);
    eq(result.steps, 16);
    eq(result.chain.length, 17);
  }],
  ["Collatz of 27 has 111 steps", () => {
    const result = collatz(27);
    eq(result.steps, 111);
    eq(result.chain.length, 112);
    eq(result.chain[0], 27n);
    eq(result.chain[result.chain.length - 1], 1n);
  }],
  ["Collatz calculator can be called repeatedly without stale state", () => {
    const calculator = createCollatzCalculator();
    for (const [n, expectedSteps] of [[3, 7], [1, 0], [6, 8], [3, 7], [2, 1]] as const) {
      const result = calculator(n);
      eq(result.steps, expectedSteps);
      eq(result.chain[0], BigInt(n));
      eq(result.chain[result.chain.length - 1], 1n);
    }
  }],
  ["BigInt beyond safe-number range preserves precision", () => {
    const result = collatz(2n ** 60n);
    eq(result.steps, 60);
    eq(result.chain[0], 2n ** 60n);
    eq(result.chain[result.chain.length - 1], 1n);
  }],
  ["Collatz validates natural-number input", () => {
    for (const n of [0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      throws(() => collatz(n), RangeError);
    }
    throws(() => collatz(0n), RangeError);
  }],
  ["Collatz finite step budget fails clearly and later calls still work", () => {
    const calculate = createCollatzCalculator(1);
    throws(() => calculate(3), RangeError);
    eq(calculate(2).steps, 1);
    eq(calculate(1).steps, 0);
  }],
  ["Full chain obeys Collatz rule on every edge", () => {
    const result = collatz(97);
    ok(result.steps > 0);
    eq(result.chain.length - 1, result.steps);
    for (let i = 0; i < result.steps; i++) {
      const value = result.chain[i]!;
      const expected = value % 2n === 0n ? value / 2n : 3n * value + 1n;
      eq(result.chain[i + 1], expected);
    }
  }],
];
