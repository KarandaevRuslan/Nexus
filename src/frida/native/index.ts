/** Native-only adapter entrypoint for standalone Frida agent bundles. */
export { attachHook } from "./hooks";
export { observeModule } from "./modules";
export type { NativePointerLike, FridaModule, FridaInvocation, FridaRuntime, HookCallbacks } from "./types";
