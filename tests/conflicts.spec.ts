import { ReadContext, Context, PostCommitReactionError, Dispatcher, Handler } from "../src/core";
import { eq, ok, throws, values } from "./helpers";

function mathFixture(options: ConstructorParameters<typeof Dispatcher>[0] = {}) {
  const d = new Dispatcher(options);
  const A = d.store(10);
  const pulse = d.store<void>(undefined);
  const effects: string[] = [];
  let firstRuns = 0, secondRuns = 0;
  class Multiply extends Handler {
    run(ctx: Context): void {
      firstRuns++;
      ctx.update(A, value => value * 2);
      ctx.effect(() => effects.push("multiply"));
    }
  }
  class Add extends Handler {
    run(ctx: Context): void {
      secondRuns++;
      ctx.update(A, value => value + 3);
      ctx.effect(() => effects.push("add"));
    }
  }
  const multiply = d.register(new Multiply(), { on: { any: [pulse] }, execution: "inline" });
  const add = d.register(new Add(), { on: { any: [pulse] }, execution: "inline" });
  const fire = () => d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  return { d, A, multiply, add, effects, fire, runs: () => [firstRuns, secondRuns] };
}

async function defaultReject(): Promise<void> {
  const f = mathFixture();
  throws(f.fire, PostCommitReactionError);
  eq(values(f.d, f.A), 10);
  eq(f.effects.length, 0);
  eq(f.d.currentRevision, 1); // Only the input pulse was committed.
}

async function sequenceMultiplyThenAdd(): Promise<void> {
  const f = mathFixture();
  f.d.conflicts.add({ store: f.A, between: [f.multiply, f.add], resolve: { strategy: "sequence", order: [f.multiply, f.add] } });
  const observed: Array<[number, number, number]> = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      observed.push([ctx.before.read(f.A), ctx.after.read(f.A), ctx.after.revision]);
    }
  }
  f.d.register(new Observe(), { on: { any: [f.A] }, delivery: "each", execution: "inline" });
  f.fire();
  eq(values(f.d, f.A), 23);
  eq(observed.length, 1);
  eq(observed[0]!.join(","), "10,23,2");
  eq(f.d.currentRevision, 2);
  eq(f.effects.join(","), "multiply,add");
  // Intentional: speculative handlers are re-run. Only effects from re-run are committed.
  eq(f.runs().join(","), "2,2");
}

async function sequenceAddThenMultiply(): Promise<void> {
  const f = mathFixture();
  f.d.conflicts.add({ store: f.A, between: [f.multiply, f.add], resolve: { strategy: "sequence", order: [f.add, f.multiply] } });
  f.fire();
  eq(values(f.d, f.A), 26);
  eq(f.effects.join(","), "add,multiply");
}

async function skipWave(): Promise<void> {
  const f = mathFixture();
  f.d.conflicts.add({ store: f.A, between: [f.multiply, f.add], resolve: { strategy: "skip" } });
  f.fire();
  eq(values(f.d, f.A), 10);
  eq(f.d.currentRevision, 1);
  eq(f.effects.length, 0);
}

async function fallbackSkip(): Promise<void> {
  const f = mathFixture({ conflictFallback: "skip" });
  f.fire();
  eq(values(f.d, f.A), 10);
  eq(f.effects.length, 0);
}

async function ruleLifecycleAndValidation(): Promise<void> {
  const f = mathFixture();
  const rule = { store: f.A, between: [f.multiply, f.add] as const, resolve: { strategy: "sequence" as const, order: [f.multiply, f.add] as const } };
  const handle = f.d.conflicts.add(rule);
  throws(() => f.d.conflicts.add(rule));
  throws(() => f.d.conflicts.add({ store: f.A, between: [f.multiply, f.add], resolve: { strategy: "sequence", order: [f.multiply, f.multiply] } }));
  handle.dispose();
  eq(handle.active, false);
  throws(f.fire, PostCommitReactionError);
  const installed = f.d.conflicts.add(rule);
  f.add.dispose(); // Clean associated rules when registration goes away.
  eq(installed.active, false);
  f.fire(); // Only multiply remains.
  eq(values(f.d, f.A), 20);
}

async function multiWriterAndCyclicRules(): Promise<void> {
  const d = new Dispatcher();
  const pulse = d.store<void>(undefined), A = d.store(10);
  class Multiply extends Handler { run(ctx: Context): void { ctx.update(A, n => n * 2); } }
  class Add extends Handler { run(ctx: Context): void { ctx.update(A, n => n + 3); } }
  class Subtract extends Handler { run(ctx: Context): void { ctx.update(A, n => n - 1); } }
  const a = d.register(new Multiply(), { on: { any: [pulse] }, execution: "inline" });
  const b = d.register(new Add(), { on: { any: [pulse] }, execution: "inline" });
  const c = d.register(new Subtract(), { on: { any: [pulse] }, execution: "inline" });
  d.conflicts.add({ store: A, between: [a, b], resolve: { strategy: "sequence", order: [a, b] } });
  d.conflicts.add({ store: A, between: [b, c], resolve: { strategy: "sequence", order: [b, c] } });
  // A-C rule is required: all colliding pairs must be explicitly accounted for.
  throws(() => d.inline(ctx => ctx.set(pulse, undefined, { record: "always" })), PostCommitReactionError);
  d.conflicts.add({ store: A, between: [a, c], resolve: { strategy: "sequence", order: [a, c] } });
  d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  eq(values(d, A), 22); // (10 * 2 + 3) - 1

  // Adding another conflicting active rule set with a cycle must fail BEFORE commit.
  const e = new Dispatcher();
  const t = e.store<void>(undefined), x = e.store(1);
  const regs = [new Multiply(), new Add(), new Subtract()].map((_h, i) =>
    e.register(new (class extends Handler { run(ctx: Context): void { ctx.update(x, n => n + i + 1); } })(), { on: { any: [t] }, execution: "inline" })
  );
  const [p, q, r] = regs as [typeof regs[number], typeof regs[number], typeof regs[number]];
  e.conflicts.add({ store: x, between: [p, q], resolve: { strategy: "sequence", order: [p, q] } });
  e.conflicts.add({ store: x, between: [q, r], resolve: { strategy: "sequence", order: [q, r] } });
  e.conflicts.add({ store: x, between: [p, r], resolve: { strategy: "sequence", order: [r, p] } });
  throws(() => e.inline(ctx => ctx.set(t, undefined, { record: "always" })), PostCommitReactionError);
  eq(values(e, x), 1);
}

async function guardReevaluatesAndObservesStaging(): Promise<void> {
  const d = new Dispatcher();
  const trigger = d.store(0), A = d.store(10), B = d.store(0);
  const observed: number[] = [];
  class First extends Handler {
    run(ctx: Context): void { ctx.update(A, n => n * 2); ctx.set(B, ctx.read(A)); }
  }
  class Second extends Handler {
    when(ctx: ReadContext): boolean { observed.push(ctx.read(A)); return ctx.read(A) >= 20; }
    run(ctx: Context): void { ctx.update(A, n => n + 3); }
  }
  const first = d.register(new First(), { on: { any: [trigger] }, execution: "inline" });
  const second = d.register(new Second(), { on: { any: [trigger] }, execution: "inline" });
  d.conflicts.add({ store: A, between: [first, second], resolve: { strategy: "sequence", order: [first, second] } });
  // The guard initially returns false: no collision; first commits A=20, B=20.
  d.inline(ctx => ctx.set(trigger, 1));
  eq(values(d, A), 20);
  eq(values(d, B), 20);
  ok(observed.includes(10));
  // Second now passes its guard and writes A; order works on the next trigger.
  d.inline(ctx => ctx.set(trigger, 2));
  eq(values(d, A), 43);
  eq(values(d, B), 40);
  eq(observed[observed.length - 1], 40);
}

async function noConflictPreservesWave(): Promise<void> {
  const d = new Dispatcher();
  const pulse = d.store(0), a = d.store(0), b = d.store(0);
  class H1 extends Handler { run(ctx: Context): void { ctx.set(a, 1); } }
  class H2 extends Handler { run(ctx: Context): void { ctx.set(b, 2); } }
  d.register(new H1(), { on: { any: [pulse] }, execution: "inline" });
  d.register(new H2(), { on: { any: [pulse] }, execution: "inline" });
  d.inline(ctx => ctx.set(pulse, 1));
  eq(d.currentRevision, 2); // 1 source + 1 combined wave
  eq(values(d, a), 1);
  eq(values(d, b), 2);
}


async function skipCancelsUnrelatedWrites(): Promise<void> {
  const f = mathFixture();
  const other = f.d.store(0);
  class Unrelated extends Handler {
    run(ctx: Context): void {
      ctx.set(other, 123);
      ctx.effect(() => f.effects.push("unrelated"));
    }
  }
  // A third, non-conflicting registration belongs to the SAME atomic wave.
  const pulse = f.multiply.sources[0]!;
  f.d.register(new Unrelated(), { on: { any: [pulse] }, execution: "inline" });
  f.d.conflicts.add({ store: f.A, between: [f.multiply, f.add], resolve: { strategy: "skip" } });
  f.fire();
  eq(values(f.d, other), 0);
  eq(f.effects.length, 0);
  eq(f.d.currentRevision, 1);
}

async function atomicRollbackOnSequentialFailure(): Promise<void> {
  const d = new Dispatcher();
  const A = d.store(10), pulse = d.store<void>(undefined);
  let n = 0;
  let effects = 0;
  class First extends Handler {
    run(ctx: Context): void {
      ctx.update(A, x => x * 2);
      ctx.effect(() => effects++);
    }
  }
  class Second extends Handler {
    run(ctx: Context): void {
      n++;
      if (n === 2) throw new Error("Failure on re-evaluation");
      ctx.update(A, x => x + 3);
    }
  }
  const first = d.register(new First(), { on: { any: [pulse] }, execution: "inline" });
  const second = d.register(new Second(), { on: { any: [pulse] }, execution: "inline" });
  d.conflicts.add({ store: A, between: [first, second], resolve: { strategy: "sequence", order: [first, second] } });
  throws(() => d.inline(ctx => ctx.set(pulse, undefined, { record: "always" })));
  eq(values(d, A), 10);
  eq(effects, 0);
  eq(d.currentRevision, 1);
}

async function sequenceReadsPreviousStagedStores(): Promise<void> {
  const d = new Dispatcher();
  const A = d.store(10), B = d.store(0), pulse = d.store<void>(undefined);
  class First extends Handler {
    run(ctx: Context): void {
      ctx.update(A, n => n * 2);
      ctx.set(B, 9);
    }
  }
  class Second extends Handler {
    run(ctx: Context): void {
      ctx.set(A, ctx.read(A) + ctx.read(B));
    }
  }
  const first = d.register(new First(), { on: { any: [pulse] }, execution: "inline" });
  const second = d.register(new Second(), { on: { any: [pulse] }, execution: "inline" });
  d.conflicts.add({ store: A, between: [first, second], resolve: { strategy: "sequence", order: [first, second] } });
  d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  eq(values(d, A), 29);
  eq(values(d, B), 9);
  eq(d.currentRevision, 2);
}


async function dynamicReplayWritesNeedRules(): Promise<void> {
  const d = new Dispatcher();
  const A = d.store(10), stage = d.store(false), pulse = d.store<void>(undefined);
  class First extends Handler {
    run(ctx: Context): void {
      ctx.update(A, n => n * 2);
      ctx.set(stage, true);
    }
  }
  class Second extends Handler {
    run(ctx: Context): void { ctx.update(A, n => n + 3); }
  }
  class Third extends Handler {
    run(ctx: Context): void {
      if (ctx.read(stage)) ctx.update(A, n => n + 1);
    }
  }
  const first = d.register(new First(), { on: { any: [pulse] }, execution: "inline" });
  const second = d.register(new Second(), { on: { any: [pulse] }, execution: "inline" });
  d.register(new Third(), { on: { any: [pulse] }, execution: "inline" });
  d.conflicts.add({ store: A, between: [first, second], resolve: { strategy: "sequence", order: [first, second] } });
  // Initially Third writes nothing.  After replaying First it starts writing A.
  // This must NOT silently become an extra unordered write.
  throws(() => d.inline(ctx => ctx.set(pulse, undefined, { record: "always" })), PostCommitReactionError);
  eq(values(d, A), 10);
  eq(values(d, stage), false);
}

export const conflictCases: Array<[string, () => Promise<void>]> = [
  ["conflict default is reject (no partial commit)", defaultReject],
  ["sequence multiply-then-add atomically produces 23", sequenceMultiplyThenAdd],
  ["reverse sequence produces 26", sequenceAddThenMultiply],
  ["skip conflict wave without effects", skipWave],
  ["configurable fallback skip", fallbackSkip],
  ["conflict rule disposal and validation", ruleLifecycleAndValidation],
  ["all pairs required and conflicting order rejected", multiWriterAndCyclicRules],
  ["guard re-evaluation uses staged values", guardReevaluatesAndObservesStaging],
  ["conflict-free wave still shares one commit", noConflictPreservesWave],
  ["skip drops unrelated writes from same wave", skipCancelsUnrelatedWrites],
  ["failed ordered replay publishes nothing", atomicRollbackOnSequentialFailure],
  ["ordered replay sees earlier staged Store writes", sequenceReadsPreviousStagedStores],
  ["new write overlaps found during replay require rules", dynamicReplayWritesNeedRules],
];
