import type { Dispatcher, Scope } from "../../core/index";
import { PostCommitReactionError } from "../../core/errors";
import type { FridaInvocation, FridaRuntime, NativePointerLike, HookCallbacks } from "./types";

/** A Frida listener is owned by a Scope; individual callbacks get fresh, short-lived Contexts. */
export function attachHook<TInvocation extends object = Record<string, unknown>>(
  dispatcher: Dispatcher,
  scope: Scope,
  runtime: FridaRuntime,
  address: NativePointerLike,
  hooks: HookCallbacks<TInvocation>,
): void {
  if (!scope.active) throw new Error("Scope is disposed");
  const stateKey = Symbol("nexusInvocationState");
  // The onLeave callback must not receive a fabricated empty state when
  // onEnter failed. Weak tracking survives until onLeave or GC without leaks.
  const failedEnters = new WeakSet<object>();
  const listener = runtime.Interceptor.attach(address, {
    onEnter(this: FridaInvocation, args) {
      // Frida detach may fail after Scope closure; a still-installed listener
      // must never execute user code or initiate a Nexus transaction.
      if (!scope.active || !hooks.onEnter) return;
      const invocation = this as FridaInvocation & { [key: symbol]: unknown };
      failedEnters.delete(invocation);
      const state = {} as TInvocation;
      invocation[stateKey] = state;
      // A reaction may fail AFTER the onEnter transaction has committed.
      // Its invocation state must survive until onLeave in that case.
      let callbackReturned = false;
      try {
        dispatcher.inline(ctx => {
          hooks.onEnter!(ctx, args, state, this);
          callbackReturned = true;
        });
      } catch (error) {
        if (callbackReturned && error instanceof PostCommitReactionError) {
          // No native-boundary throw or onLeave suppression after a Commit.
          dispatcher._reportExternalError(error);
          return;
        }
        delete invocation[stateKey];
        failedEnters.add(invocation);
        throw error;
      }
    },
    onLeave(this: FridaInvocation, retval) {
      const invocation = this as FridaInvocation & { [key: symbol]: unknown };
      try {
        if (failedEnters.has(invocation) || !scope.active || !hooks.onLeave) return;
        const state = (invocation[stateKey] ?? {}) as TInvocation;
        dispatcher.inline(ctx => hooks.onLeave!(ctx, retval, state, this));
      } finally {
        // Even suppressed callbacks must release their invocation state.
        delete invocation[stateKey];
        failedEnters.delete(invocation);
      }
    },
  });
  try {
    scope.cleanup(() => listener.detach());
  } catch (error) {
    try { listener.detach(); } catch { /* preserve owner-registration failure */ }
    throw error;
  }
}
