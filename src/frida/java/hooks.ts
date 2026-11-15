import type { Dispatcher, Scope } from "../../core";
import type { JavaBridgeLike, JavaMethodLike } from "./types";
import type { ManagedFailurePolicy, ManagedHookCallbacks, ManagedHookHandle } from "../managed/types";
import { invokeManaged, installationGate } from "../managed/invocation";
import { validateManagedCallbacks, validateSignature } from "../managed/options";
import { claimJavaMethod } from "./registry";

/** Installs one Nexus-managed hook per Java overload. A second hook to the
 * same method is rejected rather than silently replacing the first one.
 * `failure: 'propagate'` is intended for hooks whose action is mandatory;
 * `passthrough` preserves v0.1.16's error-report-and-call-original behavior.
 */
export function attachJavaHook<Args extends unknown[] = unknown[], Result = unknown>(
  dispatcher: Dispatcher,
  scope: Scope,
  java: JavaBridgeLike,
  options: {
    className: string;
    methodName: string;
    overload: readonly string[];
    callbacks: ManagedHookCallbacks<Args, Result>;
    invokeOriginal?: (receiver: unknown, args: Args) => Result;
    failure?: ManagedFailurePolicy;
  },
): ManagedHookHandle {
  if (!scope.active) throw new Error("Scope is disposed");
  if (!options || typeof options.className !== "string" || !options.className ||
      typeof options.methodName !== "string" || !options.methodName) {
    throw new TypeError("Java hook requires className and methodName");
  }
  validateSignature(options.overload, "Java overload");
  const signature = Object.freeze([...options.overload]);
  const className = options.className;
  const methodName = options.methodName;
  const config = validateManagedCallbacks(options, "Java hook");
  const customOriginal = options.invokeOriginal;

  const gate = installationGate();
  let installed = false;
  const handle: ManagedHookHandle = {
    ready: gate.ready,
    get active() { return installed && scope.active; },
  };
  try {
    java.perform(() => {
      try {
        if (!scope.active) { gate.resolve(); return; }
        const clazz = java.use(className);
        const group = clazz[methodName] as { overload?: (...args: string[]) => JavaMethodLike } | undefined;
        if (!group || typeof group.overload !== "function") throw new Error(`Java method not found: ${className}.${methodName}`);
        const method = group.overload(...signature);
        if (!method || typeof method.call !== "function") throw new Error("Invalid Java overload method");
        // Claims are retained until successful Scope cleanup, including when
        // a third party replaced our wrapper and restoration initially fails.
        const release = claimJavaMethod(java, method, [className, methodName, signature]);
        let wrapper: ((this: unknown, ...values: unknown[]) => Result) | undefined;
        let previous: JavaMethodLike["implementation"];
        let replaced = false;
        try {
          previous = method.implementation;
          const original = customOriginal ?? ((receiver: unknown, args: Args) => method.call(receiver, ...args) as Result);
          wrapper = function (this: unknown, ...values: unknown[]): Result {
            return invokeManaged(dispatcher, scope, this, values as Args, original, config.callbacks, config.failure);
          };
          method.implementation = wrapper;
          replaced = true;
          scope.cleanup(() => {
            if (method.implementation !== wrapper) throw new Error("Java hook implementation was replaced externally");
            method.implementation = previous!;
            installed = false;
            release();
          });
          installed = true;
          gate.resolve();
        } catch (error) {
          try {
            if (replaced && method.implementation === wrapper) method.implementation = previous!;
          } finally {
            release();
          }
          throw error;
        }
      } catch (error) { gate.reject(error); }
    });
  } catch (error) { gate.reject(error); }
  return handle;
}
