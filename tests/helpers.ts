import type { Dispatcher, Store } from "../src/core";


export function eq(actual: unknown, expected: unknown, message = "Values differ"): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
export function ok(value: unknown, message = "Expected truthy value"): void {
  if (!value) throw new Error(message);
}
export function throws(fn: () => unknown, type: new (...args: any[]) => Error = Error): void {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  if (!(caught instanceof type)) throw new Error(`Expected ${type.name}, got ${String(caught)}`);
}
export function values<T>(dispatcher: Dispatcher, store: Store<T>): T {
  return dispatcher.inline(ctx => ctx.read(store));
}
