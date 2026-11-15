export { attachHook } from "./native/hooks";
export { observeModule } from "./native/modules";
export type { NativePointerLike, FridaModule, FridaInvocation, FridaRuntime, HookCallbacks } from "./native/types";
export { attachJavaHook } from "./java/hooks";
export { attachIl2CppHook } from "./il2cpp/hooks";
export { ManagedHookFailure } from "./managed/invocation";
export type {
  ManagedCall, ManagedHookCallbacks, ManagedHookHandle, ManagedFailurePolicy,
} from "./managed/types";
export type { JavaBridgeLike, JavaClassLike, JavaMethodLike } from "./java/types";
export type { Il2CppBridgeLike, Il2CppClassLike, Il2CppMethodLike } from "./il2cpp/types";
