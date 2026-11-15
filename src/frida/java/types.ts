/** Minimal injected Java Bridge surface (no global Bridge dependency). */
export interface JavaMethodLike {
  /** Native method handle exposed by frida-java-bridge; provides stable overload identity. */
  readonly handle?: { toString(): string };
  implementation: ((this: unknown, ...args: any[]) => unknown) | null;
  call(receiver: unknown, ...args: any[]): unknown;
}
export interface JavaClassLike {
  [member: string]: unknown;
}
export interface JavaBridgeLike {
  perform(callback: () => void): void;
  use(className: string): JavaClassLike;
}

