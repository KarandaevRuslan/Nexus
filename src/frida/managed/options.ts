import type { ManagedFailurePolicy, ManagedHookCallbacks } from "./types";

/** Snapshot user callbacks/config before touching any Bridge resource. */
export function validateManagedCallbacks<Args extends unknown[], Result>(
  options: { callbacks: ManagedHookCallbacks<Args, Result>; failure?: ManagedFailurePolicy; invokeOriginal?: unknown },
  adapter: string,
): { readonly callbacks: Readonly<ManagedHookCallbacks<Args, Result>>; readonly failure: ManagedFailurePolicy } {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${adapter} options must be an object`);
  }
  const callbacks = options.callbacks;
  if (!callbacks || typeof callbacks !== "object" || Array.isArray(callbacks)) {
    throw new TypeError(`${adapter} callbacks must be an object`);
  }
  const { before, after } = callbacks;
  if (before !== undefined && typeof before !== "function") {
    throw new TypeError(`${adapter} callbacks.before must be a function`);
  }
  if (after !== undefined && typeof after !== "function") {
    throw new TypeError(`${adapter} callbacks.after must be a function`);
  }
  if (options.invokeOriginal !== undefined && typeof options.invokeOriginal !== "function") {
    throw new TypeError(`${adapter} invokeOriginal must be a function`);
  }
  const failure = options.failure ?? "passthrough";
  if (failure !== "passthrough" && failure !== "propagate") {
    throw new TypeError(`${adapter} failure must be 'passthrough' or 'propagate'`);
  }
  return { callbacks: Object.freeze({ before, after }), failure };
}

export function validateSignature(value: unknown, name: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.length)) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
}
