/** Regression tests for failure and lifecycle defects found in the v0.1.5 audit. */
import { Context, Dispatcher, Handler } from "../src/core";
import { attachHook, observeModule } from "../src/frida-adapter";
import type { FridaRuntime, NativePointerLike } from "../src/frida-adapter";
import { eq, throws, values } from "./helpers";

async function failedEffectDoesNotStrandInline(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: e => errors.push(e) });
  const source = d.store(0);
  let observed = 0;
  class Observe extends Handler {
    override run(): void { observed++; }
  }
  d.register(new Observe(), { on: { any: [source] }, execution: "inline" });
  d.inline(ctx => {
    ctx.set(source, 1);
    ctx.effect(() => { throw new Error("effect crash"); });
  });
  eq(values(d, source), 1);
  eq(observed, 1);
  eq(errors.length, 1);
  eq((errors[0] as Error).message, "effect crash");
  d.inline(() => {});
  eq(observed, 1);
}

async function submitResolvesAfterFailedEffect(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: e => errors.push(e) });
  const counter = d.store(0);
  const result = await d.submit(ctx => {
    ctx.set(counter, 10);
    ctx.effect(() => { throw new Error("native failure"); });
    return 123;
  });
  eq(result, 123);
  eq(values(d, counter), 10);
  eq(d.currentRevision, 1);
  eq(errors.length, 1);
}

async function effectFailuresDoNotSkipLaterEffects(): Promise<void> {
  let reports = 0, done = 0;
  const d = new Dispatcher({ onError: () => { reports++; throw Error("reporting failed"); } });
  // The reporting callback is intentionally broken: absorb expected diagnostics.
  const originalError = console.error;
  let fallbackReports = 0;
  console.error = () => { fallbackReports++; };
  try {
    d.inline(ctx => {
      ctx.effect(() => { throw Error("first"); });
      ctx.effect(() => { done++; });
      ctx.effect(() => { throw Error("last"); });
    });
  } finally { console.error = originalError; }
  eq(done, 1);
  eq(reports, 2);
  eq(fallbackReports, 2);
}

async function scopeDisposesDespiteUnrelatedPendingJobs(): Promise<void> {
  const d = new Dispatcher();
  const s = d.scope();
  const own = s.store(1);
  const independent = d.store(1);
  let executed = 0;
  class Run extends Handler { override run(ctx: Context): void { ctx.read(independent); executed++; } }
  const reg = d.register(new Run(), { delivery: "each", execution: "deferred" });
  d.request(reg);
  s.dispose();
  throws(() => values(d, own));
  d.flush();
  eq(executed, 1);
  reg.dispose();
}

async function failedScopeDisposalCanRetryWithoutRepeatingCleanup(): Promise<void> {
  const d = new Dispatcher();
  const s = d.scope();
  const own = s.store(9);
  let cleanups = 0;
  s.cleanup(() => { cleanups++; });
  const outside = d.register(new class extends Handler { override run(): void {} }(), { on: { any: [own] } });
  throws(() => s.dispose(), AggregateError);
  eq(cleanups, 1);
  eq(values(d, own), 9);
  throws(() => s.store(2));
  outside.dispose();
  s.dispose();
  eq(cleanups, 1);
  throws(() => values(d, own));
  s.dispose();
}

async function registrationDisposalIsDeferredUntilAfterCommit(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  let first = 0, second = 0;
  let secondReg: ReturnType<Dispatcher["register"]>;
  class First extends Handler {
    override run(ctx: Context): void {
      first++;
      // A post-commit action is allowed, but cannot cancel an already
      // admitted sibling in the same atomic wave.
      ctx.effect(() => secondReg.dispose());
    }
  }
  class Second extends Handler { override run(): void { second++; } }
  d.register(new First(), { on: { any: [source] }, execution: "inline" });
  secondReg = d.register(new Second(), { on: { any: [source] }, execution: "inline" });
  d.inline(ctx => ctx.set(source, 1));
  eq(first, 1);
  eq(second, 1);
  eq(secondReg.active, false);
}

async function repeatedEachRequestsRunSequentially(): Promise<void> {
  const d = new Dispatcher();
  const value = d.store(0);
  let runs = 0;
  class Increment extends Handler {
    override run(ctx: Context): void { runs++; ctx.update(value, x => x + 1); }
  }
  const reg = d.register(new Increment(), { delivery: "each" });
  d.request(reg);
  d.request(reg);
  d.flush();
  eq(values(d, value), 2);
  eq(runs, 2);
}

async function nestedInlineCannotPublishBeforeParent(): Promise<void> {
  const d = new Dispatcher();
  const outer = d.store(0), inner = d.store(0);
  throws(() => d.inline(ctx => {
    ctx.set(outer, 1);
    d.inline(other => other.set(inner, 42));
  }));
  eq(values(d, outer), 0);
  eq(values(d, inner), 0);
}

async function nestedInlineInsideHandlerCannotCommit(): Promise<void> {
  const d = new Dispatcher();
  const signal = d.store(0), outer = d.store(0), inner = d.store(0);
  class Nested extends Handler {
    override run(ctx: Context): void {
      ctx.set(outer, 1);
      d.inline(other => other.set(inner, 42));
    }
  }
  d.register(new Nested(), { on: { any: [signal] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(signal, 1)));
  eq(values(d, outer), 0);
  eq(values(d, inner), 0);
  eq(values(d, signal), 1); // initiating transaction already committed
}

async function postCommitEffectMayReenterNativeHook(): Promise<void> {
  const d = new Dispatcher();
  const result = d.store(0);
  d.inline(ctx => ctx.effect(() => d.inline(other => other.set(result, 7))));
  eq(values(d, result), 7);
}

async function deferredWaveErrorRestoresIndependentJobs(): Promise<void> {
  const d = new Dispatcher();
  const event = d.store(0), output = d.store(0);
  let failed = 0, succeeded = 0;
  class Failing extends Handler {
    override run(): void { failed++; throw Error("run failed"); }
  }
  class Independent extends Handler {
    override run(ctx: Context): void { succeeded++; ctx.set(output, 42); }
  }
  d.register(new Failing(), { on: { any: [event] }, execution: "deferred" });
  d.register(new Independent(), { on: { any: [event] }, execution: "deferred" });
  d.inline(ctx => ctx.set(event, 1));
  throws(() => d.flush());
  eq(succeeded, 0);
  d.flush();
  eq(succeeded, 1);
  eq(failed, 1);
  eq(values(d, output), 42);
}

async function failedInlineWaveStillRunsUnaffectedSiblings(): Promise<void> {
  const d = new Dispatcher();
  const input = d.store(0), output = d.store(0);
  let ran = 0;
  class Failing extends Handler { override run(): void { throw Error("bad"); } }
  class Independent extends Handler {
    override run(ctx: Context): void { ran++; ctx.set(output, 11); }
  }
  d.register(new Failing(), { on: { any: [input] }, execution: "inline" });
  d.register(new Independent(), { on: { any: [input] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(input, 1)));
  eq(values(d, output), 11);
  eq(ran, 1);
}

function pointer(): NativePointerLike {
  return {
    add: () => pointer(),
    toString: () => "0x1",
    toInt32: () => 1,
    isNull: () => false,
    equals: () => true,
  };
}

async function failedHookOwnershipDetachesListener(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  let attached = 0, detached = 0;
  const runtime = {
    Interceptor: {
      attach: () => {
        attached++;
        scope.dispose(); // disposal during external attachment
        return { detach: () => { detached++; } };
      },
    },
  } as unknown as FridaRuntime;
  throws(() => attachHook(d, scope, runtime, pointer(), {}));
  eq(attached, 1);
  eq(detached, 1);
}

async function failedObserverOwnershipDetachesObserver(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  let attached = 0, detached = 0;
  const runtime = {
    Process: {
      attachModuleObserver: () => {
        attached++;
        scope.dispose();
        return { detach: () => { detached++; } };
      },
    },
  } as unknown as FridaRuntime;
  throws(() => observeModule(d, scope, runtime, "example.so", () => {}));
  eq(attached, 1);
  eq(detached, 1);
}

async function disposedStoreCannotBeReadFromHeldContextSnapshot(): Promise<void> {
  const d = new Dispatcher();
  const gone = d.store(123), signal = d.store(0);
  const scope = d.scope();
  const owned = scope.store(5);
  class Late extends Handler { override run(ctx: Context): void { ctx.read(owned); } }
  d.register(new Late(), { on: { any: [signal] }, execution: "deferred" });
  d.inline(ctx => ctx.set(signal, 1));
  scope.dispose();
  eq(values(d, gone), 123);
  throws(() => d.flush());
}

export const recoveryCases: Array<[string, () => Promise<void>]> = [
  ["effect errors do not strand inline reactions", failedEffectDoesNotStrandInline],
  ["submit resolves after commit despite effect failure", submitResolvesAfterFailedEffect],
  ["effect failure does not skip other effects or throw from onError", effectFailuresDoNotSkipLaterEffects],
  ["Scope disposes while unrelated jobs are pending", scopeDisposesDespiteUnrelatedPendingJobs],
  ["failed Scope disposal can retry without repeating released resources", failedScopeDisposalCanRetryWithoutRepeatingCleanup],
  ["post-commit registration disposal preserves current atomic wave", registrationDisposalIsDeferredUntilAfterCommit],
  ["repeated each requests for one registration are sequential", repeatedEachRequestsRunSequentially],
  ["nested inline in an external transaction is forbidden", nestedInlineCannotPublishBeforeParent],
  ["nested inline in a Handler cannot bypass parent commit", nestedInlineInsideHandlerCannotCommit],
  ["postcommit effect may reenter Dispatcher", postCommitEffectMayReenterNativeHook],
  ["deferred wave preserves independent siblings after failure", deferredWaveErrorRestoresIndependentJobs],
  ["inline wave processes other jobs even when one throws", failedInlineWaveStillRunsUnaffectedSiblings],
  ["failed Frida hook ownership detaches listener", failedHookOwnershipDetachesListener],
  ["failed Frida observer ownership detaches observer", failedObserverOwnershipDetachesObserver],
  ["historical jobs cannot read disposed Store", disposedStoreCannotBeReadFromHeldContextSnapshot],
];
