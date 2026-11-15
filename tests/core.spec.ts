import { ConflictError, Context, Dispatcher, PostCommitReactionError, Handler } from "../src/core";
import type { Change } from "../src/core";
import { eq, throws, values } from "./helpers";

async function case1(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(3), b = d.store(0);
  let context!: Context;
  d.inline(ctx => {
    context = ctx;
    eq(ctx.read(a), 3);
    ctx.set(a, 4);
    eq(ctx.read(a), 4);  // read-your-writes
    ctx.update(a, v => v * 2);
    eq(ctx.read(a), 8);
    ctx.set(b, ctx.read(a) + 2);
  });
  eq(values(d, a), 8);
  eq(values(d, b), 10);
  throws(() => context.read(a), Error);
}

async function case2(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0);
  const captured: Array<{ change: Change<number>; before: number; after: number; beforeRevision: number; afterRevision: number }> = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      const change = ctx.change(a);
      if (change) captured.push({
        change,
        before: ctx.before.read(a),
        after: ctx.after.read(a),
        beforeRevision: ctx.before.revision,
        afterRevision: ctx.after.revision,
      });
    }
  }
  d.register(new Observe(), { on: { any: [a] }, delivery: "each", execution: "inline" });
  d.inline(ctx => { ctx.set(a, 10); ctx.set(a, 90); ctx.set(a, 20); });
  eq(values(d, a), 20);
  eq(captured.length, 1);
  eq(captured[0]?.before, 0);
  eq(captured[0]?.after, 20);
  eq(captured[0]?.beforeRevision, 0);
  eq(captured[0]?.afterRevision, 1);
  eq(captured[0]?.change.kind, "changed");
  d.inline(ctx => ctx.set(a, 20));
  eq(captured.length, 1);
  d.inline(ctx => ctx.set(a, 20, { record: "always" }));
  eq(captured.length, 2);
  eq(captured[1]?.change.kind, "touched");
  const pulse = d.store<void>(undefined);
  let seen = 0;
  class Pulse extends Handler { run(): void { seen++; } }
  d.register(new Pulse(), { on: { any: [pulse] }, delivery: "each", execution: "inline" });
  d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  eq(seen, 1);
}

async function case3(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0), b = d.store(0);
  let anyRuns = 0, allRuns = 0;
  class Any extends Handler { run(): void { anyRuns++; } }
  class All extends Handler { run(): void { allRuns++; } }
  d.register(new Any(), { on: { any: [a, b] }, execution: "inline" });
  d.register(new All(), { on: { all: [a, b] }, execution: "inline" });
  d.inline(ctx => ctx.set(a, 1));
  eq(anyRuns, 1); eq(allRuns, 0);
  d.inline(ctx => ctx.set(a, 2));
  eq(anyRuns, 2); eq(allRuns, 0);
  d.inline(ctx => ctx.set(b, 1));
  eq(anyRuns, 3); eq(allRuns, 1);
  d.inline(ctx => ctx.set(b, 2));
  eq(allRuns, 1);
  d.inline(ctx => { ctx.set(a, 3); ctx.set(b, 3); });
  eq(anyRuns, 5); eq(allRuns, 2);
}

async function case4(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0), threshold = d.store(80);
  const each: Array<[number, number, number]> = [];
  const latest: number[] = [];
  class Each extends Handler {
    run(ctx: Context): void {
      const c = ctx.change(a);
      if (c) each.push([ctx.after.read(a), ctx.after.read(threshold), ctx.revision]);
    }
  }
  class Latest extends Handler { run(ctx: Context): void { latest.push(ctx.read(a)); } }
  d.register(new Each(), { on: { any: [a] }, delivery: "each", execution: "deferred" });
  d.register(new Latest(), { on: { any: [a] }, delivery: "latest", execution: "deferred" });
  void d.submit(ctx => ctx.set(a, 10));
  void d.submit(ctx => ctx.set(a, 90));
  void d.submit(ctx => ctx.set(threshold, 100));
  void d.submit(ctx => ctx.set(a, 20));
  d.flush();
  eq(each.length, 3);
  eq(each[0]?.[0], 10);
  eq(each[1]?.[0], 90);
  eq(each[1]?.[1], 80); // captured historical snapshot, not latest threshold=100
  eq(each[2]?.[1], 100);
  eq(latest.length, 1);
  eq(latest[0], 20);
}

async function case5(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0), output = d.store(0);
  const effects: string[] = [];
  class First extends Handler {
    run(ctx: Context): void { ctx.set(output, 10); ctx.effect(() => effects.push("first")); }
  }
  class Second extends Handler {
    run(ctx: Context): void { ctx.set(output, 20); ctx.effect(() => effects.push("second")); }
  }
  d.register(new First(), { on: { any: [a] }, execution: "deferred" });
  d.register(new Second(), { on: { any: [a] }, execution: "deferred" });
  d.inline(ctx => ctx.set(a, 1));
  throws(() => d.flush(), ConflictError);
  eq(values(d, output), 0);
  eq(effects.length, 0);
}

async function case6(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0);
  let runs = 0;
  class UntilFive extends Handler {
    run(ctx: Context): void {
      runs++;
      if (ctx.read(a) < 5) ctx.update(a, n => n + 1);
    }
  }
  d.register(new UntilFive(), { on: { any: [a] }, execution: "inline" });
  d.inline(ctx => ctx.set(a, 1));
  eq(values(d, a), 5);
  eq(runs, 5);
}

async function case7(): Promise<void> {
  const d = new Dispatcher({ maxInlineWaves: 8 });
  const a = d.store(0);
  class Endless extends Handler { run(ctx: Context): void { ctx.update(a, n => n + 1); } }
  d.register(new Endless(), { on: { any: [a] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(a, 1)), PostCommitReactionError);
}

async function case8(): Promise<void> {
  const d = new Dispatcher();
  const s = d.scope();
  const a = s.store(0);
  let n = 0;
  let disposed = 0;
  class Watched extends Handler {
    run(): void { n++; }
    override onDispose(): void { disposed++; }
  }
  const reg = s.register(new Watched(), { on: { any: [a] }, execution: "inline" });
  d.inline(ctx => ctx.set(a, 1));
  eq(n, 1);
  reg.dispose();
  eq(disposed, 1);
  d.inline(ctx => ctx.set(a, 2));
  eq(n, 1);
  s.dispose();
  throws(() => d.inline(ctx => ctx.read(a)));
}

async function case9(): Promise<void> {
  const d = new Dispatcher();
  const s = d.store(0);
  let p = false;
  const result = d.submit(ctx => { ctx.set(s, 12); return "done"; });
  result.then(() => { p = true; });
  d.flush();
  eq(await result, "done");
  eq(values(d, s), 12);
  eq(p, true);
  throws(() => d.register(new (class extends Handler { run(): void {} })(), {
    on: { all: [s] }, delivery: "each",
  }));
}

async function case12(): Promise<void> {
  // Event bursts can choose 'latest' for state or 'each' for every committed pulse.
  const d = new Dispatcher();
  const pulse = d.store<void>(undefined);
  let latest = 0, each = 0;
  class Latest extends Handler { run(): void { latest++; } }
  class Each extends Handler { run(): void { each++; } }
  d.register(new Latest(), { on: { any: [pulse] }, delivery: "latest" });
  d.register(new Each(), { on: { any: [pulse] }, delivery: "each" });
  for (let n = 0; n < 100; n++) {
    d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  }
  d.flush();
  eq(latest, 1);
  eq(each, 100);
}

async function case13(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const pulse = scope.store(0);
  let runs = 0;
  class Deferred extends Handler { run(): void { runs++; } }
  scope.register(new Deferred(), { on: { any: [pulse] }, delivery: "each" });
  d.inline(ctx => ctx.set(pulse, 1));
  scope.dispose(); // removes unconsumed subscriptions and snapshots
  d.flush();
  eq(runs, 0);
}

async function case15(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(0);
  class Task extends Handler { run(ctx: Context): void { ctx.update(a, x => x + 1); } }
  const task = d.register(new Task()); // Manual-only, no on-source
  d.request(task);
  d.flush();
  eq(values(d, a), 1);
  d.request(task);
  d.flush();
  eq(values(d, a), 2);
  task.dispose();
  throws(() => d.request(task));
}

async function case14(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), first = d.store(0), second = d.store(0);
  const revs: number[] = [];
  class A extends Handler { run(ctx: Context): void { ctx.set(first, ctx.read(source) + 1); } }
  class B extends Handler { run(ctx: Context): void { ctx.set(second, ctx.read(source) + 2); } }
  class End extends Handler { run(ctx: Context): void { revs.push(ctx.revision); eq(ctx.read(first), 6); eq(ctx.read(second), 7); } }
  d.register(new A(), { on: { any: [source] }, execution: "inline" });
  d.register(new B(), { on: { any: [source] }, execution: "inline" });
  d.register(new End(), { on: { all: [first, second] }, execution: "inline" });
  d.inline(ctx => ctx.set(source, 5));
  eq(revs.length, 1);
  eq(revs[0], 2); // source is revision 1; both writes publish in revision 2
}


export const coreCases: Array<[string, () => Promise<void>]> = [
  ["context read-your-writes + expiry", case1],
  ["one transition per commit + forced void pulse", case2],
  ["any / all triggers", case3],
  ["historical each snapshots vs latest", case4],
  ["atomic conflict between two handlers", case5],
  ["finite reactive feedback", case6],
  ["inline feedback safety", case7],
  ["register / unregister / Scope lifecycle", case8],
  ["deferred submit and unsupported combinations", case9],
  ["high-rate void pulses: each vs latest", case12],
  ["unregister removes pending events", case13],
  ["two independent writes form one committed wave", case14],
  ["manual-only Handler execution", case15],
];
