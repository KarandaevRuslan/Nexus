/** v0.1.14: lifetime-aware post-commit effects and atomic lifecycle boundaries. */
import { Context, Dispatcher, FeedbackError, Handler, PostCommitReactionError } from "../src/core";
import type { FridaInvocation, FridaRuntime, NativePointerLike } from "../src/frida";
import { attachHook } from "../src/frida";
import { eq, ok, throws, values } from "./helpers";

async function ownedEffectsSkipAfterScopeTeardown(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const events: string[] = [];
  d.inline(ctx => {
    ctx.effect(() => { events.push("release"); scope.dispose(); });
    ctx.effect(() => events.push("use-freed-native"), { owner: scope });
    ctx.effect(() => events.push("unowned-continues"));
  });
  eq(events.join(","), "release,unowned-continues");
  eq(scope.active, false);
}

async function effectsFromDifferentContextsRespectOwnerInOneWave(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const pulse = d.store(0);
  const trace: string[] = [];
  class Close extends Handler {
    override run(ctx: Context): void { ctx.effect(() => { trace.push("close"); scope.dispose(); }); }
  }
  class Use extends Handler {
    override run(ctx: Context): void { ctx.effect(() => trace.push("unsafe"), { owner: scope }); }
  }
  d.register(new Close(), { on: { any: [pulse] }, execution: "inline" });
  d.register(new Use(), { on: { any: [pulse] }, execution: "inline" });
  d.inline(ctx => ctx.set(pulse, 1));
  eq(trace.join(","), "close");
}

async function invalidOwnerIsRejectedBeforeCommit(): Promise<void> {
  const left = new Dispatcher();
  const right = new Dispatcher();
  const foreign = right.scope();
  const output = left.store(0);
  throws(() => left.inline(ctx => {
    ctx.set(output, 5);
    ctx.effect(() => {}, { owner: foreign });
  }));
  eq(values(left, output), 0);
  foreign.dispose();
}

async function abortedHandlerCannotDisposeAnotherRegistration(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  const target = d.store(0);
  let siblingRuns = 0;
  let sibling: ReturnType<Dispatcher["register"]>;
  class Failing extends Handler {
    override run(ctx: Context): void {
      ctx.set(target, 7);
      sibling.dispose(); // must fail BEFORE changing lifecycle
    }
  }
  class Sibling extends Handler { override run(): void { siblingRuns++; } }
  d.register(new Failing(), { on: { any: [source] }, execution: "inline" });
  sibling = d.register(new Sibling(), { on: { any: [source] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
  eq(values(d, target), 0);
  eq(sibling.active, true);
  eq(siblingRuns, 1); // restored independent job still runs
}

async function ownerEffectMayDisposeAfterSuccess(): Promise<void> {
  const d = new Dispatcher();
  const signal = d.store(0);
  let active: ReturnType<Dispatcher["register"]>;
  class Release extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => active.dispose());
    }
  }
  active = d.register(new Release(), { on: { any: [signal] }, execution: "inline" });
  d.inline(ctx => ctx.set(signal, 1));
  eq(active.active, false);
}

async function effectOnlyNestingRespectsIndependentDepth(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({
    maxInlineDepth: 8,
    maxInlineWaves: 3,
    maxCausalWaves: 2048,
    onError: e => errors.push(e),
  });
  let calls = 0;
  const recurse = (): void => {
    calls++;
    d.inline(ctx => ctx.effect(recurse));
  };
  d.inline(ctx => ctx.effect(recurse));
  ok(calls <= 8, "effect-only recursion should be bounded before stack overflow");
  ok(errors.some(e => e instanceof FeedbackError), "depth guard should report FeedbackError");
  d.inline(() => {}); // state restored for later unrelated work
}

class Ptr implements NativePointerLike {
  constructor(private readonly value: number) {}
  add(offset: number): Ptr { return new Ptr(this.value + offset); }
  toString(): string { return `0x${this.value.toString(16)}`; }
  toInt32(): number { return this.value; }
  isNull(): boolean { return this.value === 0; }
  equals(other: NativePointerLike): boolean { return other.toString() === this.toString(); }
}

async function failedHookEntrySuppressesLeaveButNextInvocationWorks(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  let callbacks: {
    onEnter?(this: FridaInvocation, args: NativePointerLike[]): void;
    onLeave?(this: FridaInvocation, result: NativePointerLike): void;
  } = {};
  const runtime = {
    Interceptor: {
      attach(_address: NativePointerLike, supplied: typeof callbacks) {
        callbacks = supplied;
        return { detach() {} };
      }
    },
  } as unknown as FridaRuntime;
  let leaveCalls = 0;
  attachHook<{ token?: number }>(d, scope, runtime, new Ptr(10), {
    onEnter(_ctx, args, state) {
      if (args[0]!.toInt32() === 0) throw new Error("entry aborted");
      state.token = args[0]!.toInt32();
    },
    onLeave(_ctx, _retval, state) {
      leaveCalls++;
      eq(state.token, 12);
    },
  });
  const first: FridaInvocation = { threadId: 4 };
  throws(() => callbacks.onEnter!.call(first, [new Ptr(0)]));
  eq(Object.getOwnPropertySymbols(first).length, 0);
  callbacks.onLeave!.call(first, new Ptr(-13));
  eq(leaveCalls, 0);
  const second: FridaInvocation = { threadId: 4 };
  callbacks.onEnter!.call(second, [new Ptr(12)]);
  callbacks.onLeave!.call(second, new Ptr(0));
  eq(leaveCalls, 1);
  eq(Object.getOwnPropertySymbols(second).length, 0);
  scope.dispose();
}

export const v0114Cases: Array<[string, () => Promise<void>]> = [
  ["v0114 owned effects skip after Scope teardown", ownedEffectsSkipAfterScopeTeardown],
  ["v0114 effects from same wave respect owner lifetime", effectsFromDifferentContextsRespectOwnerInOneWave],
  ["v0114 effects reject a foreign owner before commit", invalidOwnerIsRejectedBeforeCommit],
  ["v0114 failed handler cannot dispose another registration", abortedHandlerCannotDisposeAnotherRegistration],
  ["v0114 post-commit lifecycle disposal is permitted", ownerEffectMayDisposeAfterSuccess],
  ["v0114 effect-only nested inline calls obey depth limit", effectOnlyNestingRespectsIndependentDepth],
  ["v0114 failed onEnter suppresses onLeave and does not taint new invocation", failedHookEntrySuppressesLeaveButNextInvocationWorks],
];
