import type { Context, Scope } from "../../core";

/** Only the Bridge surface actually needed by Nexus. Pass the real bridge instance
 * explicitly, or provide a typed mock. No implicit global dependency is required.
 */
/** A single synchronous intercepted method invocation. Never retain it, its
 * receiver, or Bridge wrappers beyond the callback; they may be short-lived.
 * `args` is only a SHALLOW copy of the argument array. Replacing an element
 * (`replaceArg` or `args[index] = x`) is staged until before() succeeds; mutating
 * a field of an object/reference inside the array is an IMMEDIATE external
 * side effect and CANNOT be rolled back. The same is true for `result` objects.
 * Prefer `replaceArg` for deliberate top-level argument substitution.
 * `skipOriginal` must specify a result (including void).
 */
export interface ManagedCall<Args extends unknown[], Result> {
  readonly receiver: unknown;
  readonly args: Args;
  /** Stage a top-level argument replacement, not a field mutation. */
  replaceArg<I extends keyof Args>(index: I, value: Args[I]): void;
  readonly result: Result | undefined;
  readonly skipped: boolean;
  skipOriginal(result: Result): void;
  replaceResult(result: Result): void;
}
export type ManagedFailurePolicy = "passthrough" | "propagate";

export interface ManagedHookCallbacks<Args extends unknown[] = unknown[], Result = unknown> {
  before?(ctx: Context, call: ManagedCall<Args, Result>): void;
  after?(ctx: Context, call: ManagedCall<Args, Result>): void;
}
export interface ManagedHookHandle {
  /** Resolves when the hook is installed; rejects on an installation error.
   * Java.perform and Il2Cpp.perform may wait for runtime initialization.
   */
  readonly ready: Promise<void>;
  /** Synchronously prevents future callbacks. Scope owns hook removal. */
  readonly active: boolean;
}
export interface ManagedHookOptions<Args extends unknown[], Result> {
  /** Optional original-call implementation, useful for unusual method bindings.
   * Its execution is synchronous and should bypass the replacement hook.
   */
  invokeOriginal?: (receiver: unknown, args: Args) => Result;
  callbacks: ManagedHookCallbacks<Args, Result>;
  /** Callback failure: passthrough (legacy; report and use original) or
   * propagate (throw ManagedHookFailure, do not invoke original after a
   * failed before()). This cannot undo external object/native mutations.
   */
  failure?: ManagedFailurePolicy;
}
export type ManagedHookOwner = { readonly scope: Scope };
