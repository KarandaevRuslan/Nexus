import { Context, Dispatcher, Handler, type Change } from "../src/core";
import { eq, ok, throws, values } from "./helpers";

async function preAndPostCommit(): Promise<void> {
  const d = new Dispatcher();
  const gold = d.store(100), diamond = d.store(20), threshold = d.store(80);
  const records: Array<{ before: number[]; after: number[]; meta: Change<number> }> = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      const meta = ctx.change(gold);
      if (!meta) return;
      records.push({
        before: [ctx.before.read(gold), ctx.before.read(diamond), ctx.before.read(threshold), ctx.before.revision],
        after: [ctx.after.read(gold), ctx.after.read(diamond), ctx.after.read(threshold), ctx.after.revision],
        meta,
      });
      eq(ctx.read(gold), 500); // default reads the post-commit snapshot
    }
  }
  d.register(new Observe(), { on: { any: [gold] }, execution: "inline", delivery: "each" });
  d.inline(ctx => { ctx.set(gold, 500); ctx.set(diamond, 70); });
  eq(records.length, 1);
  eq(records[0]!.before.join(","), "100,20,80,0");
  eq(records[0]!.after.join(","), "500,70,80,1");
  eq(records[0]!.meta.kind, "changed");
  eq(records[0]!.meta.version, 1);
  eq(records[0]!.meta.revision, 1);
}

async function coalescedLatestIsLastCommit(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  const each: string[] = [];
  const latest: string[] = [];
  class Each extends Handler {
    run(ctx: Context): void {
      each.push(`${ctx.before.read(source)}>${ctx.after.read(source)}`);
    }
  }
  class Latest extends Handler {
    run(ctx: Context): void {
      latest.push(`${ctx.before.read(source)}>${ctx.after.read(source)}`);
      eq(ctx.change(source)?.revision, 3);
    }
  }
  d.register(new Each(), { on: { any: [source] }, delivery: "each" });
  d.register(new Latest(), { on: { any: [source] }, delivery: "latest" });
  d.inline(ctx => ctx.set(source, 10));
  d.inline(ctx => ctx.set(source, 20));
  d.inline(ctx => ctx.set(source, 30));
  d.flush();
  eq(each.join("|"), "0>10|10>20|20>30");
  eq(latest.join("|"), "20>30");
}

async function touchedVersusChanged(): Promise<void> {
  const d = new Dispatcher();
  const pulse = d.store<void>(undefined);
  const a = d.store(5);
  const collected: string[] = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      const change = ctx.change(a) ?? ctx.change(pulse);
      if (change) collected.push(`${change.kind}/${ctx.before.revision}/${ctx.after.revision}`);
    }
  }
  d.register(new Observe(), { on: { any: [a, pulse] }, delivery: "each", execution: "inline" });
  d.inline(ctx => ctx.set(a, 5));
  eq(d.currentRevision, 0);
  d.inline(ctx => ctx.set(a, 5, { record: "always" }));
  d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  eq(collected.join("|"), "touched/0/1|touched/1/2");
}

async function committedValuesAreDetachedAndFrozen(): Promise<void> {
  const d = new Dispatcher();
  const external = { gold: 100, inventory: [{ id: 1, amount: 10 }] };
  const player = d.store(external);
  external.gold = 777;
  external.inventory[0]!.amount = 999;
  const read = values(d, player);
  eq(read.gold, 100);
  eq(read.inventory[0]!.amount, 10);
  ok(Object.isFrozen(read) && Object.isFrozen(read.inventory) && Object.isFrozen(read.inventory[0]));
  throws(() => { (read as { gold: number }).gold = 900; }, TypeError);
  throws(() => { (read.inventory as Array<unknown>).push({}); }, TypeError);
  eq(d.currentRevision, 0);
  const pairs: string[] = [];
  class See extends Handler {
    run(ctx: Context): void {
      pairs.push(`${ctx.before.read(player).gold}>${ctx.after.read(player).gold}`);
    }
  }
  d.register(new See(), { on: { any: [player] }, delivery: "each", execution: "deferred" });
  const next = { gold: 200, inventory: [{ id: 2, amount: 11 }] };
  d.inline(ctx => ctx.set(player, next));
  next.gold = 999;
  d.inline(ctx => ctx.set(player, { gold: 300, inventory: [] }));
  d.flush();
  eq(pairs.join("|"), "100>200|200>300");
  eq(values(d, player).gold, 300);
}

async function opaqueValuesRequireExplicitPolicy(): Promise<void> {
  const d = new Dispatcher();
  throws(() => d.store(new Date(0)), TypeError);
  throws(() => d.store({ map: new Map<string, number>() }), TypeError);
  const date = new Date(0);
  const reference = d.store(date, { storage: "reference" });
  eq(values(d, reference), date);
  date.setTime(123);
  // Deliberate opt-out: the runtime makes no immutability guarantee for a reference Store.
  eq(values(d, reference).getTime(), 123);
  eq(d.currentRevision, 0);
}

async function readViewsExpireWithContext(): Promise<void> {
  const d = new Dispatcher();
  const value = d.store({ n: 1 });
  let ctx!: Context;
  d.inline(c => { ctx = c; eq(ctx.before.read(value).n, 1); });
  throws(() => ctx.after.read(value));
  throws(() => ctx.before.read(value));
}

async function readYourWritesDoNotLeakIntoSnapshot(): Promise<void> {
  const d = new Dispatcher();
  const a = d.store(5);
  d.inline(ctx => {
    ctx.set(a, 8);
    eq(ctx.read(a), 8);
    eq(ctx.after.read(a), 5);
    eq(ctx.before.read(a), 5);
  });
  eq(values(d, a), 8);
}

export const snapshotCases: Array<[string, () => Promise<void>]> = [
  ["before/after consistent multi-store commit", preAndPostCommit],
  ["latest coalescing uses final commit pair", coalescedLatestIsLastCommit],
  ["changed/touched event metadata", touchedVersusChanged],
  ["immutable detached Store objects and history", committedValuesAreDetachedAndFrozen],
  ["explicit opt-out for opaque values", opaqueValuesRequireExplicitPolicy],
  ["read views expire with Context", readViewsExpireWithContext],
  ["read-your-writes differs from committed view", readYourWritesDoNotLeakIntoSnapshot],
];
