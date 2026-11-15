/** Runtime validation at boundaries that TypeScript's void/boolean return
 * types cannot fully enforce (plain JavaScript, async functions, cross-realm
 * Promises, and custom thenables). Never await a speculative transaction.
 */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  // A throwing then getter aborts the current uncommitted transaction.
  return typeof (value as { then?: unknown }).then === "function";
}

function suppressUnhandledRejection(value: unknown): void {
  // The callback violated the synchronous contract. Observe any eventual
  // rejection so it does not become an unrelated unhandledRejection.
  try { void Promise.resolve(value).catch(() => {}); } catch { /* invalid value */ }
}

export function expectSynchronous<T>(value: T, name: string): T {
  if (isThenable(value)) {
    suppressUnhandledRejection(value);
    throw new TypeError(`${name} must be synchronous (Promise-like result returned)`);
  }
  return value;
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    if (isThenable(value)) suppressUnhandledRejection(value);
    throw new TypeError(`${name} must return a synchronous boolean`);
  }
  return value;
}
