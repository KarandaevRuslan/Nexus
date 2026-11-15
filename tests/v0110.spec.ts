/** Nexus v0.1.10: immutable policy descriptors and unambiguous post-commit failures. */
import {
  Context, Dispatcher, Handler, PostCommitReactionError,
  type ConflictRule,
} from "../src/core";
import { eq, ok, throws, values } from "./helpers";

async function conflictRuleCopiesNestedArrays(): Promise<void> {
  const d = new Dispatcher();
  const trigger = d.store(0), target = d.store(10);
  class Multiply extends Handler { run(ctx: Context): void { ctx.update(target, n => n * 2); } }
  class Add extends Handler { run(ctx: Context): void { ctx.update(target, n => n + 3); } }
  class Other extends Handler { run(): void {} }
  const a = d.register(new Multiply(), { on: { any: [trigger] }, execution: "inline" });
  const b = d.register(new Add(), { on: { any: [trigger] }, execution: "inline" });
  const c = d.register(new Other());
  const between = [a, b] as [typeof a, typeof b];
  const order = [a, b] as [typeof a, typeof b];
  const resolve = { strategy: "sequence" as const, order };
  const rawRule: ConflictRule = { store: target, between, resolve };
  const handle = d.conflicts.add(rawRule);
  eq(handle.rule === rawRule, false);
  eq(handle.rule.between === between, false);
  eq(handle.rule.resolve === resolve, false);
  ok(Object.isFrozen(handle.rule));
  ok(Object.isFrozen(handle.rule.between));
  ok(Object.isFrozen(handle.rule.resolve));
  ok(Object.isFrozen(handle));
  if (handle.rule.resolve.strategy === "sequence") ok(Object.isFrozen(handle.rule.resolve.order));

  throws(() => d.inline(() => {
    between[0] = c;
    order.reverse();
    throw Error("aborted");
  }));
  eq(handle.rule.between[0], a);
  if (handle.rule.resolve.strategy === "sequence") {
    eq(handle.rule.resolve.order[0], a);
    eq(handle.rule.resolve.order[1], b);
  }
  d.inline(ctx => ctx.set(trigger, 1));
  eq(values(d, target), 23);
  a.dispose();
  eq(handle.active, false); // membership check must use installed snapshot, not caller's array
  b.dispose(); c.dispose();
}

async function installedRuleCannotBeMutatedThroughHandle(): Promise<void> {
  const d = new Dispatcher(), target = d.store(0);
  class Nop extends Handler { run(): void {} }
  const a = d.register(new Nop()), b = d.register(new Nop());
  const handle = d.conflicts.add({ store: target, between: [a, b], resolve: { strategy: "skip" } });
  eq(Reflect.set(handle, "active", false), false);
  eq(Reflect.set(handle, "rule", null), false);
  eq(Reflect.set(handle.rule.resolve, "strategy", "reject"), false);
  eq(Reflect.set(handle.rule.between, "0", b), false);
  eq(handle.active, true);
  eq(handle.rule.resolve.strategy, "skip");
  handle.dispose();
  eq(handle.active, false);
  a.dispose(); b.dispose();
}

async function storeDescriptorIsImmutableEvenAfterRollback(): Promise<void> {
  const d = new Dispatcher(), state = d.store(0);
  ok(Object.isFrozen(state));
  throws(() => d.inline(() => {
    eq(Reflect.set(state, "equals", () => true), false);
    eq(Reflect.set(state, "id", 7), false);
    throw Error("abort");
  }));
  eq(d.currentRevision, 0);
  d.inline(ctx => ctx.set(state, 12));
  eq(values(d, state), 12);
  eq(d.currentRevision, 1);
}

async function registrationsDoNotExposeWritableLifecycleState(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0);
  class Observe extends Handler { run(): void {} }
  const reg = d.register(new Observe(), {
    on: { any: [source] }, delivery: "each",
    buffer: { capacity: 2, overflow: "drop-newest" },
  });
  ok(Object.isFrozen(reg));
  ok(Object.isFrozen(reg.sources));
  ok(Object.isFrozen(reg.buffer));
  eq((reg as unknown as { _deactivate?: unknown })._deactivate, undefined);
  for (const [name, replacement] of [
    ["active", false], ["cleanupComplete", true],
    ["cleanupInProgress", true], ["droppedJobs", 100],
  ] as const) eq(Reflect.set(reg, name, replacement), false);
  eq(Reflect.set(reg.sources, "0", null), false);
  eq(Reflect.set(reg.buffer, "capacity", 42), false);
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  d.inline(ctx => ctx.set(source, 3));
  eq(reg.droppedJobs, 1);
  eq(reg.active, true);
  reg.dispose();
  eq(reg.active, false);
  eq(reg.cleanupComplete, true);
}

async function asyncReporterRejectionIsObserved(): Promise<void> {
  const original = console.error;
  const reports: unknown[][] = [];
  console.error = (...args: unknown[]) => { reports.push(args); };
  try {
    const d = new Dispatcher({ onError: async () => { throw Error("reporter rejected"); } });
    d.inline(ctx => ctx.effect(() => { throw Error("effect failed"); }));
    await Promise.resolve();
    await Promise.resolve();
    ok(reports.length >= 1);
    ok(reports.some(args => args.some(v => String(v).includes("onError rejected"))));
    ok(reports.some(args => args.some(v => String(v).includes("reporter rejected"))));
  } finally { console.error = original; }
}

async function customThenableReporterIsObserved(): Promise<void> {
  const original = console.error;
  let fallback = 0, invoked = 0;
  console.error = () => { fallback++; };
  try {
    const d = new Dispatcher({ onError: (() => {
      invoked++;
      return { then(_resolve: unknown, reject: (error: unknown) => void) { reject(Error("failed custom thenable")); } };
    }) as (error: unknown) => void });
    d.inline(ctx => ctx.effect(() => { throw Error("effect failed"); }));
    await Promise.resolve();
    await Promise.resolve();
    eq(invoked, 1);
    eq(fallback, 1);
  } finally { console.error = original; }
}

async function inlineReactionFailureHasCommitMetadata(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0), derived = d.store(0);
  class Fails extends Handler {
    run(ctx: Context): void {
      ctx.set(derived, 99);
      throw Error("reaction crashed");
    }
  }
  d.register(new Fails(), { on: { any: [source] }, execution: "inline" });
  let failure: unknown;
  try { d.inline(ctx => { ctx.set(source, 1); return "done"; }); }
  catch (error) { failure = error; }
  if (!(failure instanceof PostCommitReactionError)) throw Error(`Expected PostCommitReactionError, got ${String(failure)}`);
  eq(failure.committedRevision, 1);
  eq((failure.cause as Error).message, "reaction crashed");
  eq(values(d, source), 1);
  eq(values(d, derived), 0);
  eq(d.currentRevision, 1);
}

async function precommitFailureIsNotMislabelled(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0);
  let failure: unknown;
  try { d.inline(ctx => { ctx.set(source, 2); throw new TypeError("precommit failed"); }); }
  catch (error) { failure = error; }
  ok(failure instanceof TypeError);
  eq(failure instanceof PostCommitReactionError, false);
  eq(values(d, source), 0);
  eq(d.currentRevision, 0);
}

async function postCommitRevisionIsOriginalNotNestedEffectRevision(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0), later = d.store(0);
  // If the post-commit effect triggers another transaction, the origin's
  // recorded revision must still be 1 (not the nested revision 2).
  d.inline(ctx => {
    ctx.set(source, 1);
    ctx.effect(() => d.inline(next => next.set(later, 2)));
  });
  eq(values(d, source), 1);
  eq(values(d, later), 2);
  eq(d.currentRevision, 2);
  // The inner transaction didn't change the original commit's recorded version.
  eq(d.inline(ctx => ctx.version(source)), 1);
}

async function cleanupRejectsNonFunctionAtRegistrationTime(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope(), state = scope.store(1);
  throws(() => scope.cleanup(123 as never), TypeError);
  throws(() => scope.cleanup(null as never), TypeError);
  let calls = 0;
  scope.cleanup(() => { calls++; });
  scope.dispose();
  eq(calls, 1);
  throws(() => values(d, state));
  scope.dispose();
}

export const v0110Cases: Array<[string, () => Promise<void>]> = [
  ["v0110 conflict rules own frozen nested arrays and ordering", conflictRuleCopiesNestedArrays],
  ["v0110 conflict handle cannot mutate installed rule or active state", installedRuleCannotBeMutatedThroughHandle],
  ["v0110 Store comparator is immutable after transaction rollback", storeDescriptorIsImmutableEvenAfterRollback],
  ["v0110 Registration lifecycle metadata cannot be overwritten", registrationsDoNotExposeWritableLifecycleState],
  ["v0110 async onError rejection is handled", asyncReporterRejectionIsObserved],
  ["v0110 custom thenable onError rejection is handled", customThenableReporterIsObserved],
  ["v0110 inline failure reports already committed revision and cause", inlineReactionFailureHasCommitMetadata],
  ["v0110 pre-commit failures remain ordinary errors", precommitFailureIsNotMislabelled],
  ["v0110 post-commit effects can trigger nested commits", postCommitRevisionIsOriginalNotNestedEffectRevision],
  ["v0110 invalid Scope.cleanup argument rejected immediately", cleanupRejectsNonFunctionAtRegistrationTime],
];
