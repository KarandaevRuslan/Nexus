import type { Dispatcher, Scope } from "../../core";
import { PostCommitReactionError } from "../../core/errors";
import { expectSynchronous } from "../../core/internal/contracts-runtime";
import type { ManagedCall, ManagedFailurePolicy, ManagedHookCallbacks } from "./types";

/** Shared runtime transaction protocol for Java and IL2CPP wrappers.
 * Bridge callbacks are synchronous, and original implementation is always
 * invoked outside the Nexus transaction. Any Nexus reaction error after the
 * callback's successful commit is diagnosed, not misclassified as rollback.
 */
/** Signals interception failure and whether the original call already ran. */
export class ManagedHookFailure extends Error {
  constructor(
    readonly phase: "before" | "after",
    readonly originalCalled: boolean,
    readonly cause: unknown,
  ) {
    super(`Managed hook ${phase} failed${originalCalled ? " after original invocation" : " before original invocation"}`);
    this.name = "ManagedHookFailure";
  }
}

export function invokeManaged<Args extends unknown[], Result>(
  dispatcher: Dispatcher,
  scope: Scope,
  receiver: unknown,
  rawArgs: Args,
  original: (receiver: unknown, args: Args) => Result,
  callbacks: Readonly<ManagedHookCallbacks<Args, Result>>,
  failure: ManagedFailurePolicy = "passthrough",
): Result {
  if (!scope.active) return original(receiver, rawArgs);
  const args = [...rawArgs] as Args;
  let skipped = false;
  let hasResult = false;
  let result!: Result;
  let open = true;
  let phase: "before" | "after" = "before";
  const assertOpen = (): void => { if (!open) throw new Error("Managed invocation expired"); };
  const call: ManagedCall<Args, Result> = {
    get receiver() { assertOpen(); return receiver; },
    get args() { assertOpen(); return args; },
    replaceArg(index, value) {
      assertOpen();
      if (phase !== "before") throw new Error("replaceArg is only valid in before()");
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= args.length) {
        throw new RangeError("replaceArg index is out of bounds");
      }
      args[index] = value;
    },
    get skipped() { assertOpen(); return skipped; },
    get result() { assertOpen(); return hasResult ? result : undefined; },
    skipOriginal(value) {
      assertOpen();
      if (phase !== "before") throw new Error("skipOriginal is only valid in before()");
      skipped = true;
      hasResult = true;
      result = value;
    },
    replaceResult(value) {
      assertOpen();
      hasResult = true;
      result = value;
    },
  };
  const execute = (phase: "before" | "after"): void => {
    const cb = callbacks[phase];
    if (!cb || !scope.active) return;
    let returned = false;
    try {
      dispatcher.inline(ctx => {
        expectSynchronous(cb(ctx, call), `ManagedHook.${phase}`);
        returned = true;
      });
    } catch (error) {
      if (returned && error instanceof PostCommitReactionError) {
        dispatcher._reportExternalError(error);
        return;
      }
      throw error;
    }
  };
  try {
    // Do not pass a failed speculative argument/result modification to native.
    // The original is called once unless skipOriginal was explicitly selected.
    try {
      execute("before");
    } catch (error) {
      // A failed before-transaction must not pass its speculative argument
      // mutations to the real method. Report and fall back to the original.
      if (failure === "propagate") throw new ManagedHookFailure("before", false, error);
      dispatcher._reportExternalError(error);
      return original(receiver, rawArgs);
    }
    if (!skipped) {
      const originalValue = original(receiver, args);
      // An explicit replacement selected by before() is preserved.
      if (!hasResult) result = originalValue;
      hasResult = true;
    }
    const committedResult = result;
    phase = "after";
    try {
      execute("after");
    } catch (error) {
      // after() failed before committing its writes. Avoid leaking a
      // speculative replacement into the Java/IL2CPP caller.
      if (failure === "propagate") throw new ManagedHookFailure("after", !skipped, error);
      dispatcher._reportExternalError(error);
      return committedResult;
    }
    return result;
  } finally {
    open = false;
  }
}

/** A ready promise that reports installation failures but also has a built-in
 * rejection observer so unobserved async initialization cannot take down the
 * agent with an unhandledRejection. Consumers can still await/catch `ready`.
 */
export function installationGate(): {
  ready: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  void ready.catch(() => {});
  return { ready, resolve, reject };
}
