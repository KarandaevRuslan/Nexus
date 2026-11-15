/** Minimal injected IL2CPP Bridge surface (no global Bridge dependency). */
export interface Il2CppMethodLike {
  implementation: ((this: unknown, ...args: any[]) => unknown) | null | undefined;
  invoke(...args: any[]): unknown;
  revert(): void;
  overload?(...parameterTypes: string[]): Il2CppMethodLike;
}
export interface Il2CppClassLike {
  method(name: string): Il2CppMethodLike;
}
export interface Il2CppBridgeLike {
  perform(callback: () => void): PromiseLike<unknown> | void;
  domain: {
    assembly(name: string): { image: { class(name: string): Il2CppClassLike } };
  };
}

