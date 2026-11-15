/** Regressions for the seven independently reproduced v0.1.6 bugs. */
import { Context, Dispatcher, Handler } from "../src/core";
import { observeModule } from "../src/frida-adapter";
import type { FridaModule, FridaRuntime } from "../src/frida-adapter";
import { eq, ok, throws, values } from "./helpers";

async function comparatorCannotCommitNestedRevision(): Promise<void> {
  const d = new Dispatcher();
  const inner = d.store(0);
  const outer = d.store(0, {
    equals: (a, b) => {
      d.inline(ctx => ctx.set(inner, 1));
      return Object.is(a, b);
    },
  });
  throws(() => d.inline(ctx => ctx.set(outer, 1)));
  eq(d.currentRevision, 0);
  eq(values(d, outer), 0);
  eq(values(d, inner), 0);
  // A failed commit must not poison the next independent transaction.
  d.inline(ctx => ctx.set(inner, 7));
  eq(d.currentRevision, 1);
  eq(values(d, inner), 7);
}

async function latestFirstDoesNotMergeDuplicateEach(): Promise<void> {
  const d = new Dispatcher();
  const target = d.store(0);
  let runs = 0;
  class Empty extends Handler { override run(): void {} }
  class Increment extends Handler {
    override run(ctx: Context): void { runs++; ctx.update(target, x => x + 1); }
  }
  const latest = d.register(new Empty(), { delivery: "latest" });
  const each = d.register(new Increment(), { delivery: "each" });
  d.request(latest);
  d.request(each);
  d.request(each);
  d.flush();
  eq(runs, 2);
  eq(values(d, target), 2);
}

async function inlineInitialSelfDisposalDoesNotLeak(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  let calls = 0;
  let cleanup = 0;
  class SelfDispose extends Handler {
    override run(): void { calls++; scope.dispose(); }
    override onDispose(): void { cleanup++; }
  }
  const handler = new SelfDispose();
  throws(() => scope.register(handler, { initial: true, execution: "inline" }));
  // v0.1.12: disposal inside an uncommitted handler is rejected before
  // changing Scope state. The failed initial Registration is still cleaned.
  eq(scope.active, true);
  eq(calls, 1);
  eq(cleanup, 1);
  const fresh = d.register(handler);
  fresh.dispose();
  scope.dispose();
}

async function initialRegistrationCannotEscapeUncommittedCallback(): Promise<void> {
  const d = new Dispatcher();
  const parent = d.store(0), child = d.store(0);
  let childRuns = 0;
  class Child extends Handler {
    override run(ctx: Context): void { childRuns++; ctx.set(child, 1); }
  }
  throws(() => d.inline(ctx => {
    ctx.set(parent, 7);
    d.register(new Child(), { initial: true, execution: "inline" });
  }));
  eq(values(d, parent), 0);
  eq(values(d, child), 0);
  eq(childRuns, 0);
  eq(d.currentRevision, 0);
}

async function initialRegistrationCannotEscapeUncommittedHandler(): Promise<void> {
  const d = new Dispatcher();
  const input = d.store(0), parent = d.store(0), child = d.store(0);
  class Child extends Handler {
    override run(ctx: Context): void { ctx.set(child, 1); }
  }
  class Parent extends Handler {
    override run(ctx: Context): void {
      ctx.set(parent, 7);
      d.register(new Child(), { initial: true, execution: "inline" });
    }
  }
  d.register(new Parent(), { on: { any: [input] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(input, 1)));
  eq(values(d, parent), 0);
  eq(values(d, child), 0);
  eq(d.currentRevision, 1); // only the initiating input changed
}

async function moduleChildCleanupFailureIsRetained(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: error => errors.push(error) }), parent = d.scope();
  let callbacks!: { onAdded(m: FridaModule): void; onRemoved(m: FridaModule): void };
  let detach = 0, cleanupAttempts = 0;
  const runtime = {
    Process: {
      attachModuleObserver(cb: typeof callbacks) {
        callbacks = cb;
        return { detach: () => { detach++; } };
      },
    },
  } as unknown as FridaRuntime;
  observeModule(d, parent, runtime, "lib.so", (_mod, child) => {
    child.cleanup(() => {
      cleanupAttempts++;
      if (cleanupAttempts === 1) throw new Error("cleanup failed");
    });
    throw new Error("initialization failed");
  });
  const module = {
    name: "lib.so",
    base: { toString: () => "0x1000" },
    size: 200,
  } as FridaModule;
  callbacks.onAdded(module); // Foreign runtime callbacks now report via onError.
  eq(errors.length, 1);
  ok(errors[0] instanceof AggregateError);
  eq((errors[0] as AggregateError).errors.length, 2);
  eq(cleanupAttempts, 1);
  parent.dispose();
  eq(cleanupAttempts, 2);
  eq(detach, 1);
}

async function asyncEffectsReportFailuresWithoutRejectingCommit(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: e => errors.push(e) });
  const n = d.store(0);
  const value = await d.submit(ctx => {
    ctx.set(n, 10);
    ctx.effect(async () => { throw new Error("async effect failed"); });
    return 123;
  });
  eq(value, 123);
  eq(values(d, n), 10);
  // Rejection must be handled through onError rather than unhandledRejection.
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  eq(errors.length, 1);
  eq((errors[0] as Error).message, "async effect failed");
}

async function failedOnDisposeMustStayRetryable(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  let attempts = 0;
  class Fault extends Handler {
    override run(): void {}
    override onDispose(): void {
      attempts++;
      if (attempts === 1) throw Error("transient failure");
    }
  }
  const handler = new Fault();
  const reg = scope.register(handler);
  throws(() => scope.dispose(), AggregateError);
  eq(reg.active, false);
  eq(reg.cleanupComplete, false);
  // Cannot register same instance while it still has pending cleanup.
  throws(() => d.register(handler));
  scope.dispose();
  eq(attempts, 2);
  eq(reg.cleanupComplete, true);
  const again = d.register(handler);
  again.dispose();
  eq(attempts, 3);
}

async function comparatorCannotMutateLifecycleDuringCommit(): Promise<void> {
  const d = new Dispatcher();
  const reg = d.register(new (class extends Handler { override run(): void {} })());
  const s = d.store(0, { equals: (a, b) => {
    reg.dispose();
    return Object.is(a, b);
  }});
  throws(() => d.inline(ctx => ctx.set(s, 1)));
  eq(reg.active, true);
  eq(values(d, s), 0);
  reg.dispose();
}

export const v017Cases: Array<[string, () => Promise<void>]> = [
  ["equals cannot recursively commit state", comparatorCannotCommitNestedRevision],
  ["latest-first grouping separates repeated each jobs", latestFirstDoesNotMergeDuplicateEach],
  ["Scope self-disposal during initial inline does not leak registration", inlineInitialSelfDisposalDoesNotLeak],
  ["initial registration is blocked inside inline callback", initialRegistrationCannotEscapeUncommittedCallback],
  ["initial registration is blocked inside Handler.run", initialRegistrationCannotEscapeUncommittedHandler],
  ["failed module child cleanup remains owned and retried", moduleChildCleanupFailureIsRetained],
  ["async effect rejection reaches onError", asyncEffectsReportFailuresWithoutRejectingCommit],
  ["failed onDispose remains retryable without reactivation", failedOnDisposeMustStayRetryable],
  ["equals cannot dispose registration during commit", comparatorCannotMutateLifecycleDuringCommit],
];
