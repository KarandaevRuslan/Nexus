/** v0.1.15: registration-owned effects and committed onEnter errors. */
import { Context, Dispatcher, Handler, PostCommitReactionError } from "../src/core";
import { attachHook } from "../src/frida";
import type { FridaInvocation, FridaRuntime, NativePointerLike } from "../src/frida";
import { eq, ok, throws, values } from "./helpers";

async function originatingRegistrationControlsEffectLifetime(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const trigger = scope.store(0);
  const trace: string[] = [];
  let other: ReturnType<Dispatcher["register"]>;
  class Release extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => {
        other.dispose();
        trace.push("released");
      });
    }
  }
  class Use extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => trace.push("USE_AFTER_FREE"), { owner: scope });
    }
    override onDispose(): void { trace.push("onDispose"); }
  }
  scope.register(new Release(), { on: { any: [trigger] }, execution: "inline" });
  other = scope.register(new Use(), { on: { any: [trigger] }, execution: "inline" });
  d.inline(ctx => ctx.set(trigger, 1));
  eq(trace.join(","), "onDispose,released");
  eq(other.active, false);
  eq(scope.active, true);
  scope.dispose();
}

async function registrationLifetimeOptOutIsExplicit(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const trigger = scope.store(0);
  const trace: string[] = [];
  let other: ReturnType<Dispatcher["register"]>;
  class Release extends Handler {
    override run(ctx: Context): void { ctx.effect(() => other.dispose()); }
  }
  class IndependentEffect extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => trace.push("independent"), { lifetime: "independent" });
    }
  }
  scope.register(new Release(), { on: { any: [trigger] }, execution: "inline" });
  other = scope.register(new IndependentEffect(), { on: { any: [trigger] }, execution: "inline" });
  d.inline(ctx => ctx.set(trigger, 1));
  eq(trace.join(","), "independent");
  scope.dispose();
}

async function independentEffectStillRespectsExplicitScope(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const trigger = scope.store(0);
  const trace: string[] = [];
  class Close extends Handler {
    override run(ctx: Context): void { ctx.effect(() => scope.dispose()); }
  }
  class Use extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => trace.push("unsafe"), { owner: scope, lifetime: "independent" });
    }
  }
  scope.register(new Close(), { on: { any: [trigger] }, execution: "inline" });
  scope.register(new Use(), { on: { any: [trigger] }, execution: "inline" });
  d.inline(ctx => ctx.set(trigger, 1));
  eq(trace.length, 0);
  eq(scope.active, false);
}

async function sequenceReplayRetainsEffectOrigin(): Promise<void> {
  const d = new Dispatcher();
  const shared = d.store(10);
  const pulse = d.store(0);
  const trace: string[] = [];
  let other: ReturnType<Dispatcher["register"]>;
  class First extends Handler {
    override run(ctx: Context): void {
      ctx.update(shared, n => n * 2);
      ctx.effect(() => other.dispose());
    }
  }
  class Second extends Handler {
    override run(ctx: Context): void {
      ctx.update(shared, n => n + 3);
      ctx.effect(() => trace.push("unsafe"));
    }
    override onDispose(): void { trace.push("freed"); }
  }
  const first = d.register(new First(), { on: { any: [pulse] }, execution: "inline" });
  other = d.register(new Second(), { on: { any: [pulse] }, execution: "inline" });
  d.conflicts.add({
    store: shared,
    between: [first, other],
    resolve: { strategy: "sequence", order: [first, other] },
  });
  d.inline(ctx => ctx.set(pulse, 1));
  eq(values(d, shared), 23);
  eq(trace.join(","), "freed");
  eq(other.active, false);
}

async function effectLifetimeOptionsRejectTyposBeforeCommit(): Promise<void> {
  const d = new Dispatcher();
  const value = d.store(0);
  throws(() => d.inline(ctx => {
    ctx.set(value, 7);
    ctx.effect(() => {}, { lifetime: "typo" } as never);
  }), TypeError);
  eq(values(d, value), 0);
}

class Ptr implements NativePointerLike {
  constructor(private readonly value: number) {}
  add(offset: number): Ptr { return new Ptr(this.value + offset); }
  toString(): string { return `0x${this.value.toString(16)}`; }
  toInt32(): number { return this.value; }
  isNull(): boolean { return this.value === 0; }
  equals(other: NativePointerLike): boolean { return other.toString() === this.toString(); }
}

type Hook = {
  onEnter?(this: FridaInvocation, args: NativePointerLike[]): void;
  onLeave?(this: FridaInvocation, result: NativePointerLike): void;
};

async function committedOnEnterReactionFailurePreservesOnLeaveState(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: error => errors.push(error) });
  const scope = d.scope();
  const source = scope.store(0);
  class BreakReaction extends Handler {
    override run(): void { throw new Error("reaction crashed"); }
  }
  scope.register(new BreakReaction(), { on: { any: [source] }, execution: "inline" });
  let installed!: Hook;
  const runtime = {
    Interceptor: {
      attach(_address: NativePointerLike, hooks: Hook) {
        installed = hooks;
        return { detach() {} };
      },
    },
  } as unknown as FridaRuntime;
  const observed: number[] = [];
  attachHook<{ token?: number }>(d, scope, runtime, new Ptr(0x1234), {
    onEnter(ctx, args, state) {
      state.token = args[0]!.toInt32();
      ctx.set(source, 1);
    },
    onLeave(_ctx, _retval, state) { observed.push(state.token!); },
  });
  const invocation: FridaInvocation = { threadId: 1 };
  // A failed REACTION after commit must not throw through Frida or suppress leave.
  installed.onEnter!.call(invocation, [new Ptr(75)]);
  eq(values(d, source), 1);
  eq(d.currentRevision, 1);
  eq(errors.length, 1);
  ok(errors[0] instanceof PostCommitReactionError);
  eq((errors[0] as PostCommitReactionError).committedRevision, 1);
  installed.onLeave!.call(invocation, new Ptr(0));
  eq(observed.join(","), "75");
  eq(Object.getOwnPropertySymbols(invocation).length, 0);
  scope.dispose();
}

async function preCommitUserErrorStillSuppressesLeave(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  let installed!: Hook;
  const runtime = {
    Interceptor: {
      attach(_address: NativePointerLike, hooks: Hook) {
        installed = hooks;
        return { detach() {} };
      },
    },
  } as unknown as FridaRuntime;
  let leaves = 0;
  attachHook(d, scope, runtime, new Ptr(0x777), {
    onEnter() {
      // An exception with the same class deliberately thrown BEFORE commit
      // must not be treated as an actual committed reaction failure.
      throw new PostCommitReactionError(100, new Error("user exception"));
    },
    onLeave() { leaves++; },
  });
  const invocation: FridaInvocation = { threadId: 2 };
  throws(() => installed.onEnter!.call(invocation, []), PostCommitReactionError);
  installed.onLeave!.call(invocation, new Ptr(0));
  eq(leaves, 0);
  scope.dispose();
}

export const v0115Cases: Array<[string, () => Promise<void>]> = [
  ["v0115 Handler effect skipped after origin registration disposed", originatingRegistrationControlsEffectLifetime],
  ["v0115 Handler effect may explicitly outlive registration", registrationLifetimeOptOutIsExplicit],
  ["v0115 independent effect still honors Scope ownership", independentEffectStillRespectsExplicitScope],
  ["v0115 sequence replay retains originating registration", sequenceReplayRetainsEffectOrigin],
  ["v0115 invalid effect lifetime rejected before commit", effectLifetimeOptionsRejectTyposBeforeCommit],
  ["v0115 committed Frida onEnter preserves invocation state", committedOnEnterReactionFailurePreservesOnLeaveState],
  ["v0115 Frida pre-commit error still suppresses onLeave", preCommitUserErrorStillSuppressesLeave],
];
