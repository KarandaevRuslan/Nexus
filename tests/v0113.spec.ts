import { Dispatcher, Handler, PostCommitReactionError } from "../src/core";
import type { Context, ReadContext } from "../src/core";
import { attachHook } from "../src/frida";
import type { FridaRuntime, FridaInvocation, NativePointerLike } from "../src/frida";
import { eq, ok, throws, values } from "./helpers";

class Ptr implements NativePointerLike {
  constructor(private readonly address: number) {}
  add(offset: number): Ptr { return new Ptr(this.address + offset); }
  toString(): string { return `0x${this.address.toString(16)}`; }
  toInt32(): number { return this.address; }
  isNull(): boolean { return this.address === 0; }
  equals(other: NativePointerLike): boolean { return other.toString() === this.toString(); }
}

/** Frida's retval is only valid during onLeave and may be reused afterwards. */
class Retval extends Ptr {
  private valid = true;
  private result: number;
  constructor(result: number) { super(result); this.result = result; }
  override toInt32(): number { return this.result; }
  replace(value: number): void {
    if (!this.valid) throw new Error("Frida retval expired");
    this.result = value;
  }
  expire(): void { this.valid = false; }
}

async function reentrantPostCommitNativeComparison(): Promise<void> {
  const dispatcher = new Dispatcher();
  const scope = dispatcher.scope();
  const target = new Ptr(0x1000);
  const compare = new Ptr(0x2000);
  const listeners = new Map<string, {
    onEnter?: (this: FridaInvocation, args: NativePointerLike[]) => void;
    onLeave?: (this: FridaInvocation, retval: NativePointerLike) => void;
  }>();
  const runtime = {
    Interceptor: {
      attach(address: NativePointerLike, callbacks: typeof listeners extends Map<string, infer V> ? V : never) {
        const key = address.toString();
        listeners.set(key, callbacks);
        return { detach: () => { listeners.delete(key); } };
      },
    },
  } as unknown as FridaRuntime;

  let pendingId = 0;
  const pending = new Map<number, Retval>();
  const active = scope.store<Record<number, number>>({});
  // Store only stable event metadata: NEVER retain the ephemeral Frida retval.
  const comparison = scope.store<{ threadId: number; token: number } | null>(null);
  const start = scope.store(0);
  const observed: number[] = [];
  let decisionRuns = 0;

  function invoke(address: Ptr, body: () => number): number {
    const callbacks = listeners.get(address.toString());
    const invocation: FridaInvocation = { threadId: 71 };
    callbacks?.onEnter?.call(invocation, []);
    const retval = new Retval(body());
    try {
      callbacks?.onLeave?.call(invocation, retval);
      return retval.toInt32();
    } finally {
      retval.expire();
    }
  }

  class OverrideComparison extends Handler {
    override when(ctx: ReadContext): boolean {
      const event = ctx.read(comparison);
      return Boolean(event && (ctx.read(active)[event.threadId] ?? 0) > 0);
    }
    override run(ctx: Context): void {
      decisionRuns++;
      const token = ctx.read(comparison)!.token;
      // The native result must be replaced while the hook's onLeave is active.
      ctx.effect(() => {
        const retval = pending.get(token);
        if (!retval) throw new Error("Too late: invocation already ended");
        retval.replace(0);
      });
    }
  }
  scope.register(new OverrideComparison(), {
    on: { any: [comparison] }, execution: "inline", delivery: "each",
  });
  attachHook(dispatcher, scope, runtime, target, {
    onEnter(ctx, _args, _state, invocation) {
      const tid = invocation.threadId;
      ctx.update(active, current => ({ ...current, [tid]: (current[tid] ?? 0) + 1 }));
    },
    onLeave(ctx, _retval, _state, invocation) {
      const tid = invocation.threadId;
      ctx.update(active, current => {
        const next = { ...current };
        if ((next[tid] ?? 0) <= 1) delete next[tid];
        else next[tid]!--;
        return next;
      });
    },
  });
  attachHook(dispatcher, scope, runtime, compare, {
    onLeave(ctx, retval, _state, invocation) {
      const token = ++pendingId;
      pending.set(token, retval as Retval);
      ctx.set(comparison, { threadId: invocation.threadId, token }, { record: "always" });
    },
  });

  // Wrap onLeave to end the native borrow only after the complete inline drain.
  const actual = listeners.get(compare.toString())!;
  listeners.set(compare.toString(), {
    ...actual,
    onLeave(this: FridaInvocation, retval: NativePointerLike) {
      const latest = pendingId + 1;
      try { actual.onLeave!.call(this, retval); }
      finally { pending.delete(latest); }
    },
  });

  class TriggerNative extends Handler {
    override run(ctx: Context): void {
      ctx.effect(() => {
        observed.push(invoke(compare, () => -13));
        observed.push(invoke(target, () => invoke(compare, () => -13)));
        observed.push(invoke(compare, () => -13));
      });
    }
  }
  scope.register(new TriggerNative(), {
    on: { any: [start] }, execution: "inline",
  });

  dispatcher.inline(ctx => ctx.set(start, 1));
  eq(observed.join(","), "-13,0,-13", "nested native call must be decided before onLeave returns");
  eq(decisionRuns, 1);
  eq(pending.size, 0);
  eq(Object.keys(values(dispatcher, active)).length, 0);
  scope.dispose();
}

async function nestedInlineDuringHandlerRunIsStillRejected(): Promise<void> {
  const dispatcher = new Dispatcher();
  const a = dispatcher.store(0);
  const b = dispatcher.store(0);
  let denied = false;
  class Parent extends Handler {
    override run(ctx: Context): void {
      throws(() => dispatcher.inline(inner => inner.set(b, 10)));
      denied = true;
      ctx.set(a, 2);
    }
  }
  const pulse = dispatcher.store(0);
  const reg = dispatcher.register(new Parent(), { on: { any: [pulse] }, execution: "inline" });
  dispatcher.inline(ctx => ctx.set(pulse, 1));
  ok(denied);
  eq(values(dispatcher, a), 2);
  eq(values(dispatcher, b), 0);
  reg.dispose();
}

async function reentrantInlineUsesSharedBudget(): Promise<void> {
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher({
    maxInlineWaves: 5,
    maxCausalWaves: 1000,
    onError: error => { errors.push(error); },
  });
  const store = dispatcher.store(0);
  let runs = 0;
  class Feedback extends Handler {
    override run(ctx: Context): void {
      runs++;
      const next = ctx.read(store) + 1;
      ctx.effect(() => { dispatcher.inline(inner => inner.set(store, next)); });
    }
  }
  dispatcher.register(new Feedback(), { on: { any: [store] }, execution: "inline" });
  dispatcher.inline(ctx => ctx.set(store, 1));
  ok(runs <= 5, "reentrant work must not reset the inline wave budget");
  ok(errors.some(error => error instanceof PostCommitReactionError), "nested budget failure should be reported");
}

export const v0113Cases: Array<[string, () => Promise<void>]> = [
  ["v0.1.13 nested Frida comparison is changed before onLeave returns", reentrantPostCommitNativeComparison],
  ["v0.1.13 uncommitted Handler still forbids nested inline", nestedInlineDuringHandlerRunIsStillRejected],
  ["v0.1.13 nested inline drains share one safety budget", reentrantInlineUsesSharedBudget],
];
