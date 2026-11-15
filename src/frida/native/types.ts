import type { Context } from "../../core/index";

export interface NativePointerLike {
  add(offset: number): NativePointerLike;
  toString(): string;
  toInt32(): number;
  isNull(): boolean;
  equals(other: NativePointerLike): boolean;
}
export interface FridaModule {
  name: string;
  base: NativePointerLike;
  size: number;
}
export interface FridaInvocation {
  threadId: number;
  [key: string]: unknown;
}
export interface FridaRuntime {
  Process: {
    attachModuleObserver(callbacks: {
      onAdded(module: FridaModule): void;
      onRemoved(module: FridaModule): void;
    }): { detach(): void };
  };
  Interceptor: {
    attach(address: NativePointerLike, callbacks: {
      onEnter?(this: FridaInvocation, args: NativePointerLike[]): void;
      onLeave?(this: FridaInvocation, result: NativePointerLike): void;
    }): { detach(): void };
  };
}

export interface HookCallbacks<TInvocation extends object> {
  onEnter?(ctx: Context, args: NativePointerLike[], state: TInvocation, invocation: FridaInvocation): void;
  onLeave?(ctx: Context, retval: NativePointerLike, state: TInvocation, invocation: FridaInvocation): void;
}
