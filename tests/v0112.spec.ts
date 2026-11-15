import { Dispatcher, Handler } from "../src/core";
import type { Context, Scope } from "../src/core";
import { attachHook, observeModule } from "../src/frida";
import type { FridaInvocation, FridaModule, FridaRuntime, NativePointerLike } from "../src/frida";
import { eq, ok, throws, values } from "./helpers";

class Ptr implements NativePointerLike {
  constructor(readonly value: number) {}
  add(offset: number): Ptr { return new Ptr(this.value + offset); }
  toString(): string { return `0x${this.value.toString(16)}`; }
  toInt32(): number { return this.value; }
  isNull(): boolean { return this.value === 0; }
  equals(other: NativePointerLike): boolean { return this.toString() === other.toString(); }
}

async function ownedChildrenCloseBeforeBorrowedParentResources(): Promise<void> {
  const dispatcher = new Dispatcher();
  const parent = dispatcher.scope();
  const configuration = parent.store("ready");
  const sequence: string[] = [];
  const child = parent.child();
  // An explicit dependency is harmless even though the child is owned.
  child.dependsOn(parent);
  child.cleanup(() => { eq(values(dispatcher, configuration), "ready"); sequence.push("child"); });
  parent.cleanup(() => sequence.push("parent"));
  parent.dispose();
  eq(sequence.join(","), "child,parent");
  eq(parent.active, false);
  eq(child.active, false);
  throws(() => values(dispatcher, configuration));
}

async function externalDependencyStillBlocksOwnerBeforeTeardown(): Promise<void> {
  const dispatcher = new Dispatcher();
  const parent = dispatcher.scope();
  const child = parent.child();
  const outsider = dispatcher.scope();
  outsider.dependsOn(parent);
  let childDisposed = false;
  child.cleanup(() => { childDisposed = true; });
  throws(() => parent.dispose());
  eq(parent.active, true);
  eq(child.active, true);
  eq(childDisposed, false);
  outsider.dispose();
  parent.dispose();
  eq(childDisposed, true);
}

async function failedOwnedChildCleanupCanRetryWithParentAlive(): Promise<void> {
  const dispatcher = new Dispatcher();
  const parent = dispatcher.scope();
  const data = parent.store(42);
  const child = parent.child();
  let attempts = 0;
  child.cleanup(() => {
    attempts++;
    eq(values(dispatcher, data), 42);
    if (attempts === 1) throw new Error("retry");
  });
  throws(() => parent.dispose(), AggregateError);
  eq(parent.active, false);
  eq(child.active, false);
  eq(values(dispatcher, data), 42);
  parent.dispose();
  eq(attempts, 2);
  throws(() => values(dispatcher, data));
}

async function observedModuleChildCanDependOnParent(): Promise<void> {
  const dispatcher = new Dispatcher();
  const parent = dispatcher.scope();
  const config = parent.store("present");
  let callbacks: { onAdded(module: FridaModule): void; onRemoved(module: FridaModule): void } | undefined;
  let detachCalls = 0;
  const runtime = {
    Process: { attachModuleObserver(cbs: NonNullable<typeof callbacks>) {
      callbacks = cbs;
      return { detach() { detachCalls++; } };
    } },
  } as unknown as FridaRuntime;
  let childCleanup = 0;
  let loadScope: Scope | undefined;
  observeModule(dispatcher, parent, runtime, "libtarget.so", (_module, child) => {
    loadScope = child;
    child.dependsOn(parent);
    child.cleanup(() => { eq(values(dispatcher, config), "present"); childCleanup++; });
  });
  const module: FridaModule = { name: "libtarget.so", base: new Ptr(0x10), size: 128 };
  ok(callbacks);
  callbacks!.onAdded(module);
  ok(loadScope);
  parent.dispose(); // Must not deadlock on its own child.
  eq(childCleanup, 1);
  eq(detachCalls, 1);
  eq(loadScope!.active, false);
}

async function observerRetainsFailedChildForRetry(): Promise<void> {
  const dispatcher = new Dispatcher({ onError() { /* collect errors in caller */ } });
  const parent = dispatcher.scope();
  let callbacks: { onAdded(module: FridaModule): void; onRemoved(module: FridaModule): void } | undefined;
  let detached = false;
  const runtime = {
    Process: { attachModuleObserver(cbs: NonNullable<typeof callbacks>) {
      callbacks = cbs;
      return { detach() { detached = true; } };
    } },
  } as unknown as FridaRuntime;
  let attempts = 0;
  observeModule(dispatcher, parent, runtime, "libtarget.so", (_module, child) => {
    child.cleanup(() => {
      attempts++;
      if (attempts === 1) throw new Error("transient cleanup");
    });
  });
  ok(callbacks);
  callbacks!.onAdded({ name: "libtarget.so", base: new Ptr(0x20), size: 64 });
  throws(() => parent.dispose(), AggregateError);
  eq(detached, false); // Stop at child failure; retry parent later.
  parent.dispose();
  eq(detached, true);
  eq(attempts, 2);
}

async function failedDetachDoesNotReactivateFridaCallbacks(): Promise<void> {
  const dispatcher = new Dispatcher();
  const scope = dispatcher.scope();
  const count = dispatcher.store(0);
  let hooks: {
    onEnter?(this: FridaInvocation, args: NativePointerLike[]): void;
    onLeave?(this: FridaInvocation, result: NativePointerLike): void;
  } = {};
  let detachAttempts = 0;
  let onEnterCalls = 0;
  let onLeaveCalls = 0;
  const runtime = {
    Interceptor: { attach(_address: NativePointerLike, callbacks: typeof hooks) {
      hooks = callbacks;
      return { detach() {
        if (++detachAttempts === 1) throw new Error("detach transient failure");
      } };
    } },
  } as unknown as FridaRuntime;
  attachHook(dispatcher, scope, runtime, new Ptr(0x1337), {
    onEnter(ctx) { onEnterCalls++; ctx.update(count, n => n + 1); },
    onLeave(ctx) { onLeaveCalls++; ctx.update(count, n => n + 1); },
  });
  const invocation = { threadId: 7 } as FridaInvocation;
  hooks.onEnter!.call(invocation, []);
  eq(Object.getOwnPropertySymbols(invocation).length, 1);
  throws(() => scope.dispose(), AggregateError);
  eq(scope.active, false);
  // Simulate Frida invoking a listener still attached after failed detach.
  hooks.onEnter!.call(invocation, []);
  hooks.onLeave!.call(invocation, new Ptr(0));
  eq(Object.getOwnPropertySymbols(invocation).length, 0);
  eq(onEnterCalls, 1);
  eq(onLeaveCalls, 0);
  eq(values(dispatcher, count), 1);
  scope.dispose();
  eq(detachAttempts, 2);
}

async function hookCleansInvocationStateIfOnEnterThrows(): Promise<void> {
  const dispatcher = new Dispatcher();
  const scope = dispatcher.scope();
  let onEnter: ((this: FridaInvocation, args: NativePointerLike[]) => void) | undefined;
  const runtime = {
    Interceptor: { attach(_address: NativePointerLike, callbacks: { onEnter?: typeof onEnter }) {
      onEnter = callbacks.onEnter;
      return { detach() {} };
    } },
  } as unknown as FridaRuntime;
  attachHook(dispatcher, scope, runtime, new Ptr(0x1337), {
    onEnter() { throw new Error("hook crashed"); },
  });
  const invocation = { threadId: 8 } as FridaInvocation;
  ok(onEnter);
  throws(() => onEnter!.call(invocation, []));
  eq(Object.getOwnPropertySymbols(invocation).length, 0);
  scope.dispose();
}

async function transactionalScopeDisposeIsRejectedBeforeStateChange(): Promise<void> {
  const dispatcher = new Dispatcher();
  const scope = dispatcher.scope();
  const store = scope.store(1);
  throws(() => dispatcher.inline(() => { scope.dispose(); }));
  eq(scope.active, true);
  eq(values(dispatcher, store), 1);
  class Test extends Handler {
    run(_ctx: Context): void { scope.dispose(); }
  }
  const reg = dispatcher.register(new Test(), { execution: "inline" });
  throws(() => dispatcher.request(reg));
  eq(scope.active, true);
  reg.dispose();
  scope.dispose();
  throws(() => values(dispatcher, store));
}

async function cannotCreateOwnedChildInFailedTransaction(): Promise<void> {
  const dispatcher = new Dispatcher();
  const parent = dispatcher.scope();
  throws(() => dispatcher.inline(() => { parent.child(); }));
  eq(parent.active, true);
  parent.dispose();
}

export const v0112Cases: Array<[string, () => Promise<void>]> = [
  ["v0112 owned children release before parent resources", ownedChildrenCloseBeforeBorrowedParentResources],
  ["v0112 external dependencies still block owned parent", externalDependencyStillBlocksOwnerBeforeTeardown],
  ["v0112 failed child cleanup retains parent Stores for retry", failedOwnedChildCleanupCanRetryWithParentAlive],
  ["v0112 module load child can depend on parent", observedModuleChildCanDependOnParent],
  ["v0112 module cleanup failure retains child for retry", observerRetainsFailedChildForRetry],
  ["v0112 hook callbacks suppressed after failed detach and invocation state cleared", failedDetachDoesNotReactivateFridaCallbacks],
  ["v0112 failed onEnter discards invocation state", hookCleansInvocationStateIfOnEnterThrows],
  ["v0112 scope disposal during transaction rejected without partial closure", transactionalScopeDisposeIsRejectedBeforeStateChange],
  ["v0112 owned child cannot be created inside unfinished transaction", cannotCreateOwnedChildInFailedTransaction],
];
