/** Runtime and lifecycle regression cases introduced in Nexus v0.1.8. */
import {
  Context, Dispatcher, Handler, RegistrationSetupError, PostCommitReactionError, type ReadContext,
} from "../src/core";
import { eq, ok, throws, values } from "./helpers";

declare const require: (id: string) => any;

async function failedInitialCleanupHasRecoveryHandle(): Promise<void> {
  const d = new Dispatcher();
  let attempts = 0;
  class Broken extends Handler {
    override run(): void { throw Error("run failed"); }
    override onDispose(): void {
      if (++attempts === 1) throw Error("cleanup failed");
    }
  }
  const h = new Broken();
  let failure: unknown;
  try { d.register(h, { initial: true, execution: "inline" }); }
  catch (error) { failure = error; }
  ok(failure instanceof RegistrationSetupError);
  eq((failure as RegistrationSetupError).executionError instanceof Error, true);
  eq((failure as RegistrationSetupError).cleanupError instanceof Error, true);
  const failedReg = (failure as RegistrationSetupError).registration;
  eq(failedReg.active, false);
  eq(failedReg.cleanupComplete, false);
  throws(() => d.register(h));
  failedReg.dispose();
  eq(attempts, 2);
  eq(failedReg.cleanupComplete, true);
  const recovered = d.register(h, { initial: false });
  recovered.dispose();
  eq(attempts, 3);
}

async function failedScopeInitialCleanupRetainsOwnership(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  let attempts = 0;
  class Broken extends Handler {
    override run(): void { throw Error("run failed"); }
    override onDispose(): void {
      if (++attempts === 1) throw Error("cleanup failed");
    }
  }
  const h = new Broken();
  throws(() => scope.register(h, { initial: true, execution: "inline" }), RegistrationSetupError);
  throws(() => d.register(h));
  scope.dispose(); // retries the registration even though Scope.register never returned
  eq(attempts, 2);
  const recovered = d.register(h, { initial: false });
  recovered.dispose();
}

async function recursiveDisposalRunsOnce(): Promise<void> {
  const d = new Dispatcher();
  let reg: ReturnType<Dispatcher["register"]>;
  let calls = 0;
  class SelfDisposal extends Handler {
    override run(): void {}
    override onDispose(): void {
      calls++;
      reg.dispose();
    }
  }
  reg = d.register(new SelfDisposal());
  reg.dispose();
  eq(calls, 1);
  eq(reg.cleanupInProgress, false);
  eq(reg.cleanupComplete, true);
  reg.dispose();
  eq(calls, 1);
}

async function recursiveFailedDisposalRetriesLaterNotInside(): Promise<void> {
  const d = new Dispatcher();
  let reg: ReturnType<Dispatcher["register"]>;
  let calls = 0;
  class Failing extends Handler {
    override run(): void {}
    override onDispose(): void {
      calls++;
      if (calls === 1) { reg.dispose(); throw Error("cleanup failed"); }
    }
  }
  reg = d.register(new Failing());
  throws(() => reg.dispose());
  eq(calls, 1);
  eq(reg.cleanupComplete, false);
  eq(reg.cleanupInProgress, false);
  reg.dispose();
  eq(calls, 2);
  eq(reg.cleanupComplete, true);
}

async function failedHandlerCleanupRetainsScopeDependencies(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  const state = scope.store(9);
  let calls = 0, externalCleanups = 0;
  class NeedsState extends Handler {
    override run(): void {}
    override onDispose(): void {
      if (++calls === 1) throw Error("try again later");
      eq(values(d, state), 9); // Store must exist at retry time
    }
  }
  scope.register(new NeedsState());
  scope.cleanup(() => { externalCleanups++; });
  throws(() => scope.dispose(), AggregateError);
  eq(values(d, state), 9);
  eq(externalCleanups, 0);
  scope.dispose();
  eq(calls, 2);
  eq(externalCleanups, 1);
  throws(() => values(d, state));
}

async function failedExternalCleanupRetainsStores(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  const state = scope.store(4);
  let attempts = 0;
  scope.cleanup(() => {
    attempts++;
    eq(values(d, state), 4);
    if (attempts === 1) throw Error("retry");
  });
  throws(() => scope.dispose(), AggregateError);
  eq(values(d, state), 4);
  scope.dispose();
  eq(attempts, 2);
  throws(() => values(d, state));
}

async function cannotCreateStoreDuringInlineOrHandler(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  let created: unknown;
  throws(() => d.inline(ctx => {
    ctx.set(source, 1);
    created = d.store("temporary");
  }));
  eq(created, undefined);
  eq(values(d, source), 0);
  eq(d.currentRevision, 0);
  class Create extends Handler {
    override run(): void { d.store("from run"); }
  }
  d.register(new Create(), { on: { any: [source] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(source, 2)));
  eq(d.currentRevision, 1); // input commit is independent of failed reaction
  d.store("outside transaction");
}

async function cannotUnregisterStoreDuringUncommittedTransaction(): Promise<void> {
  const d = new Dispatcher();
  const s = d.store(4);
  throws(() => d.inline(() => d.unregisterStore(s)));
  eq(values(d, s), 4);
  d.unregisterStore(s);
  throws(() => values(d, s));
}

async function asynchronousComparatorIsRejected(): Promise<void> {
  const d = new Dispatcher();
  const s = d.store<number>(0, { equals: (async (a: number, b: number) => a === b) as unknown as (a: number, b: number) => boolean });
  throws(() => d.inline(ctx => ctx.set(s, 8)), TypeError);
  eq(values(d, s), 0);
  eq(d.currentRevision, 0);
}

async function invalidComparatorIsRejected(): Promise<void> {
  const d = new Dispatcher();
  const s = d.store<number>(0, { equals: (() => 0) as unknown as (a: number, b: number) => boolean });
  throws(() => d.inline(ctx => ctx.set(s, 8)), TypeError);
  eq(values(d, s), 0);
}

async function asynchronousAndNonbooleanGuardsAreRejected(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0), target = d.store(0);
  let runCount = 0;
  class BadAsync extends Handler {
    override when(_ctx: ReadContext): boolean {
      return Promise.resolve(false) as unknown as boolean;
    }
    override run(ctx: Context): void { runCount++; ctx.set(target, 1); }
  }
  d.register(new BadAsync(), { on: { any: [source] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
  eq(runCount, 0);
  eq(values(d, target), 0);
  const d2 = new Dispatcher(), signal = d2.store(0);
  class BadBoolean extends Handler {
    override when(): boolean { return 1 as unknown as boolean; }
    override run(): void { throw Error("must not run"); }
  }
  d2.register(new BadBoolean(), { on: { any: [signal] }, execution: "inline" });
  throws(() => d2.inline(ctx => ctx.set(signal, 1)), PostCommitReactionError);
}

async function crossRealmRunPromiseIsRejected(): Promise<void> {
  const vm = require("node:vm") as { runInNewContext(code: string): unknown };
  const foreign = vm.runInNewContext("Promise.resolve(undefined)");
  eq(foreign instanceof Promise, false);
  const d = new Dispatcher(), source = d.store(0), target = d.store(0);
  class BadRun extends Handler {
    override run(ctx: Context): void {
      ctx.set(target, 9);
      return foreign as void;
    }
  }
  d.register(new BadRun(), { on: { any: [source] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
  eq(values(d, target), 0);
}

async function thenableInlineAndSubmitAreRejected(): Promise<void> {
  const d = new Dispatcher(), s = d.store(0);
  const thenable = { then(resolve: (value: number) => void) { resolve(1); } };
  throws(() => d.inline(ctx => {
    ctx.set(s, 1);
    return thenable;
  }), TypeError);
  eq(values(d, s), 0);
  let caught = false;
  try {
    await d.submit(ctx => { ctx.set(s, 2); return thenable; });
  } catch (error) { caught = error instanceof TypeError; }
  eq(caught, true);
  eq(values(d, s), 0);
}

export const v018Cases: Array<[string, () => Promise<void>]> = [
  ["failed initial run + onDispose exposes retryable Registration", failedInitialCleanupHasRecoveryHandle],
  ["Scope owns cleanup after failed initial Handler run", failedScopeInitialCleanupRetainsOwnership],
  ["recursive onDispose cannot execute twice", recursiveDisposalRunsOnce],
  ["recursive failing onDispose retries only in later attempt", recursiveFailedDisposalRetriesLaterNotInside],
  ["Scope preserves Store dependencies after Handler cleanup failure", failedHandlerCleanupRetainsScopeDependencies],
  ["Scope preserves Store until external cleanup succeeds", failedExternalCleanupRetainsStores],
  ["cannot create Stores from uncommitted inline or Handler", cannotCreateStoreDuringInlineOrHandler],
  ["cannot unregister Store during uncommitted transaction", cannotUnregisterStoreDuringUncommittedTransaction],
  ["async equals cannot silently discard a commit", asynchronousComparatorIsRejected],
  ["nonboolean equals is rejected", invalidComparatorIsRejected],
  ["async and nonboolean when are rejected", asynchronousAndNonbooleanGuardsAreRejected],
  ["foreign-realm Promise from Handler.run is rejected", crossRealmRunPromiseIsRejected],
  ["Promise-like inline and submit callbacks are rejected", thenableInlineAndSubmitAreRejected],
];
