import { Context, Dispatcher, FeedbackError, Handler } from "../src/core";
import { eq, ok, throws, values } from "./helpers";

async function deferredGetsTimeDuringCommandBacklog(): Promise<void> {
  const d = new Dispatcher({ maxCommandsBeforeDeferred: 2 });
  const source = d.store(0);
  const log: string[] = [];
  class Observe extends Handler { run(): void { log.push("deferred"); } }
  d.register(new Observe(), { on: { any: [source] }, execution: "deferred" });
  d.inline(ctx => ctx.set(source, 1));
  const requests: Promise<unknown>[] = [];
  for (let i = 0; i < 12; i++) requests.push(d.submit(() => { log.push(`command${i}`); }));
  // Manual flush reports a budget violation, but work and fairness state survive.
  throws(() => d.flush(3), FeedbackError);
  eq(log.join(","), "command0,command1,deferred");
  d.flush();
  await Promise.all(requests);
  eq(log.length, 13);
}

async function fairnessPersistsAcrossAutomaticTurns(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxWavesPerTurn: 1, maxCommandsBeforeDeferred: 3, onError: error => errors.push(error) });
  const input = d.store(0);
  const order: string[] = [];
  class Watch extends Handler { run(): void { order.push("deferred"); } }
  d.register(new Watch(), { on: { any: [input] } });
  d.inline(ctx => ctx.set(input, 1));
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 12; i++) pending.push(d.submit(() => { order.push("cmd"); }));
  await Promise.all(pending);
  d.flush();
  eq(order.indexOf("deferred"), 3);
  eq(errors.length, 0);
}

async function selfRequestInEffectSharesCausalLimit(): Promise<void> {
  const d = new Dispatcher({ maxCausalWaves: 4 });
  let calls = 0;
  let reg!: ReturnType<Dispatcher["register"]>;
  class Self extends Handler {
    run(ctx: Context): void {
      calls++;
      ctx.effect(() => d.request(reg));
    }
  }
  reg = d.register(new Self());
  d.request(reg);
  throws(() => d.flush(100), FeedbackError);
  eq(calls, 4);
  d.flush(); // stopped chain was discarded
}

async function chainedSubmitFromEffectCannotEvadeCausalLimit(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxCausalWaves: 3, onError: error => errors.push(error) });
  let calls = 0;
  const rejections: unknown[] = [];
  const next = (ctx: Context): void => {
    calls++;
    ctx.effect(() => { void d.submit(next).catch(error => rejections.push(error)); });
  };
  const first = d.submit(next);
  d.flush(20);
  await first;
  await Promise.resolve();
  await Promise.resolve();
  eq(calls, 3);
  eq(errors.length, 1);
  ok(errors[0] instanceof FeedbackError);
  eq(rejections.length, 1);
  d.flush();
}

async function nestedInlineFromEffectAlsoUsesCausalBudget(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxCausalWaves: 5, onError: error => errors.push(error) });
  const value = d.store(0);
  const loop = (): void => {
    d.inline(ctx => {
      ctx.update(value, v => v + 1);
      ctx.effect(loop);
    });
  };
  loop();
  // The starting inline() is external; five more reentrant effect steps are allowed.
  eq(values(d, value), 6);
  eq(errors.length, 1);
  ok(errors[0] instanceof FeedbackError);
}

async function manualRequestsAreIndependentRoots(): Promise<void> {
  const d = new Dispatcher({ maxCausalWaves: 1 });
  let calls = 0;
  class Manual extends Handler { run(): void { calls++; } }
  const reg = d.register(new Manual(), { delivery: "each" });
  d.request(reg);
  d.request(reg);
  d.flush();
  eq(calls, 2);
}

async function scopeDependencyPreventsPrematureOwnerDisposal(): Promise<void> {
  const d = new Dispatcher();
  const owner = d.scope(), borrower = d.scope();
  const config = owner.store(5);
  const pulse = borrower.store(0);
  borrower.dependsOn(owner);
  let reads = 0;
  class Consumer extends Handler { run(ctx: Context): void { reads += ctx.read(config); } }
  borrower.register(new Consumer(), { on: { any: [pulse] }, execution: "inline" });
  throws(() => owner.dispose());
  eq(owner.active, true);
  d.inline(ctx => ctx.set(pulse, 1));
  eq(reads, 5);
  borrower.dispose();
  owner.dispose();
  throws(() => values(d, config));
}

async function cyclicAndCrossDispatcherDependenciesRejected(): Promise<void> {
  const d = new Dispatcher();
  const a = d.scope(), b = d.scope();
  b.dependsOn(a);
  throws(() => a.dependsOn(b));
  throws(() => a.dependsOn(a));
  const foreign = new Dispatcher().scope();
  throws(() => b.dependsOn(foreign));
  b.dispose();
  a.dispose();
  foreign.dispose();
}

async function scopeGuardSuppressesStaleCallbacks(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const local = scope.store(0);
  const signal = scope.guard(() => d.inline(ctx => ctx.update(local, v => v + 1)));
  signal();
  eq(values(d, local), 1);
  scope.dispose();
  signal(); // must be a no-op, not a failed attempt to access a removed Store
}

async function scopeSubmitCanceledBeforeExecution(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const external = d.store(0);
  const command = scope.submit(ctx => ctx.set(external, 123));
  scope.dispose();
  let rejected = false;
  try { await command; } catch { rejected = true; }
  eq(rejected, true);
  d.flush();
  eq(values(d, external), 0);
}

async function scopeSubmitRunsWhileOpen(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const target = d.store(0);
  const result = await scope.submit(ctx => { ctx.set(target, 8); return "ok"; });
  eq(result, "ok");
  eq(values(d, target), 8);
  scope.dispose();
}

async function failedScopeCleanupRetainsBorrowedOwner(): Promise<void> {
  const d = new Dispatcher();
  const owner = d.scope(), borrower = d.scope();
  const data = owner.store("ready");
  borrower.dependsOn(owner);
  let attempt = 0;
  borrower.cleanup(() => {
    attempt++;
    if (attempt === 1) throw new Error("retry cleanup");
    eq(values(d, data), "ready");
  });
  throws(() => borrower.dispose(), AggregateError);
  throws(() => owner.dispose());
  borrower.dispose();
  owner.dispose();
  eq(attempt, 2);
}

async function invalidFairnessBudgetRejected(): Promise<void> {
  throws(() => new Dispatcher({ maxCommandsBeforeDeferred: 0 }), RangeError);
  throws(() => new Dispatcher({ maxCommandsBeforeDeferred: 1.5 }), RangeError);
}

export const v0111Cases: Array<[string, () => Promise<void>]> = [
  ["v0111 deferred work gets a guaranteed turn during a command backlog", deferredGetsTimeDuringCommandBacklog],
  ["v0111 fairness quota persists across timer turns", fairnessPersistsAcrossAutomaticTurns],
  ["v0111 effects inherit cause for repeated request", selfRequestInEffectSharesCausalLimit],
  ["v0111 chained submit effects inherit the same causal limit", chainedSubmitFromEffectCannotEvadeCausalLimit],
  ["v0111 nested inline effects respect causal budget", nestedInlineFromEffectAlsoUsesCausalBudget],
  ["v0111 independent manual requests have separate causal roots", manualRequestsAreIndependentRoots],
  ["v0111 Scope dependsOn prevents owner being disposed", scopeDependencyPreventsPrematureOwnerDisposal],
  ["v0111 cross-dispatcher and cyclic Scope dependencies rejected", cyclicAndCrossDispatcherDependenciesRejected],
  ["v0111 Scope guard skips callbacks after disposal", scopeGuardSuppressesStaleCallbacks],
  ["v0111 Scope-owned pending command canceled", scopeSubmitCanceledBeforeExecution],
  ["v0111 Scope-owned command executes while active", scopeSubmitRunsWhileOpen],
  ["v0111 failed Scope cleanup retains owner dependency", failedScopeCleanupRetainsBorrowedOwner],
  ["v0111 invalid scheduler fairness budget rejected", invalidFairnessBudgetRejected],
];
