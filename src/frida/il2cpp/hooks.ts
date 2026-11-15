import type { Dispatcher, Scope } from "../../core";
import type { Il2CppBridgeLike, Il2CppMethodLike } from "./types";
import type { ManagedFailurePolicy, ManagedHookCallbacks, ManagedHookHandle } from "../managed/types";
import { invokeManaged, installationGate } from "../managed/invocation";
import { validateManagedCallbacks, validateSignature } from "../managed/options";

/** Hook a named IL2CPP method through Il2Cpp.perform. Runtime wrappers are
 * mock-tested; the correctness of revert/invoke depends on the Bridge version.
 */
export function attachIl2CppHook<Args extends unknown[] = unknown[], Result = unknown>(
  dispatcher: Dispatcher,
  scope: Scope,
  il2cpp: Il2CppBridgeLike,
  options: {
    assembly: string;
    className: string;
    methodName: string;
    overload?: readonly string[];
    callbacks: ManagedHookCallbacks<Args, Result>;
    invokeOriginal?: (receiver: unknown, args: Args) => Result;
    failure?: ManagedFailurePolicy;
  },
): ManagedHookHandle {
  if (!scope.active) throw new Error("Scope is disposed");
  if (!options || typeof options.assembly !== "string" || !options.assembly ||
      typeof options.className !== "string" || !options.className ||
      typeof options.methodName !== "string" || !options.methodName) {
    throw new TypeError("IL2CPP hook requires assembly, className and methodName");
  }
  if (options.overload !== undefined) validateSignature(options.overload, "IL2CPP overload");
  const overload = options.overload === undefined ? undefined : Object.freeze([...options.overload]);
  const assembly = options.assembly;
  const className = options.className;
  const methodName = options.methodName;
  const config = validateManagedCallbacks(options, "IL2CPP hook");
  const customOriginal = options.invokeOriginal;

  const gate = installationGate();
  let installed = false;
  const handle: ManagedHookHandle = {
    ready: gate.ready,
    get active() { return installed && scope.active; },
  };
  try {
    const pending = il2cpp.perform(() => {
      try {
        if (!scope.active) { gate.resolve(); return; }
        const klass = il2cpp.domain.assembly(assembly).image.class(className);
        let method: Il2CppMethodLike = klass.method(methodName);
        if (overload) {
          if (typeof method.overload !== "function") throw new Error("IL2CPP Method.overload is not supported");
          method = method.overload(...overload);
        }
        if (typeof method.revert !== "function" || typeof method.invoke !== "function") {
          throw new Error("IL2CPP method must support revert() and invoke()");
        }
        const existing = method.implementation;
        if (existing != null) throw new Error("IL2CPP method already has an implementation");
        const original = customOriginal ?? ((receiver: unknown, args: Args): Result => {
          const bound = receiver as { method?: (name: string) => Il2CppMethodLike } | null;
          if (bound && typeof bound.method === "function") {
            let target = bound.method(methodName);
            if (overload) target = target.overload!(...overload);
            return target.invoke(...args) as Result;
          }
          return method.invoke(...args) as Result;
        });
        const wrapper = function (this: unknown, ...values: unknown[]): Result {
          return invokeManaged(dispatcher, scope, this, values as Args, original, config.callbacks, config.failure);
        };
        method.implementation = wrapper;
        try {
          scope.cleanup(() => {
            const current = method.implementation;
            if (current !== undefined && current !== wrapper) throw new Error("IL2CPP implementation was replaced externally");
            method.revert();
            installed = false;
          });
          installed = true;
          gate.resolve();
        } catch (error) {
          if (method.implementation === wrapper || method.implementation === undefined) method.revert();
          throw error;
        }
      } catch (error) { gate.reject(error); }
    });
    if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(pending).catch(error => gate.reject(error));
    }
  } catch (error) { gate.reject(error); }
  return handle;
}
