import type { Dispatcher, Scope } from "../../core/index";
import type { FridaModule, FridaRuntime } from "./types";
import { expectSynchronous } from "../../core/internal/contracts-runtime";

/** Observe module lifetime with one child Scope per load. Foreign Frida
 * callbacks never throw into attachModuleObserver(), which may call onAdded
 * synchronously before it returns the detachable observer handle.
 */
export function observeModule(
  dispatcher: Dispatcher,
  parent: Scope,
  runtime: FridaRuntime,
  moduleName: string,
  onLoad: (module: FridaModule, loadScope: Scope) => void,
): void {
  if (!parent.active) throw new Error("Scope is disposed");
  const loads = new Map<string, Scope>();

  // Suppress exceptions across the external runtime boundary, notably during
  // synchronous initial onAdded callbacks. Report errors using onError instead.
  const onAdded = (module: FridaModule): void => {
    try {
      if (!parent.active || module.name !== moduleName) return;
      const key = module.base.toString();
      const previous = loads.get(key);
      if (previous) {
        previous.dispose();
        loads.delete(key);
      }
      // The parent owns every load Scope before user onLoad is invoked.
      // A load Scope may also explicitly dependOn(parent); this must not
      // prevent the parent from tearing down its own children.
      const scope = parent.child();
      loads.set(key, scope);
      try {
        expectSynchronous(onLoad(module, scope), "observeModule.onLoad");
      } catch (error) {
        try {
          scope.dispose();
          loads.delete(key);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Module initialization and cleanup both failed");
        }
        throw error;
      }
    } catch (error) {
      dispatcher._reportExternalError(error);
    }
  };

  const onRemoved = (module: FridaModule): void => {
    try {
      // Once parent teardown starts it owns all remaining child cleanup;
      // late native callbacks must not race that retryable disposal.
      if (!parent.active || module.name !== moduleName) return;
      const key = module.base.toString();
      const scope = loads.get(key);
      if (!scope) return;
      scope.dispose();
      loads.delete(key);
    } catch (error) {
      // Keep failed children in loads for retry on parent disposal.
      dispatcher._reportExternalError(error);
    }
  };

  const observer = runtime.Process.attachModuleObserver({ onAdded, onRemoved });
  let observerDetached = false;
  const release = (): void => {
    const errors: unknown[] = [];
    if (!observerDetached) {
      try { observer.detach(); observerDetached = true; }
      catch (error) { errors.push(error); }
    }
    for (const [key, scope] of loads) {
      try { scope.dispose(); loads.delete(key); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Module observer cleanup failed");
  };
  try {
    parent.cleanup(release);
  } catch (error) {
    try { release(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Module observer registration and cleanup both failed"); }
    throw error;
  }
}
