import {
  BufferOverflowError, Context, Dispatcher, FeedbackError, Handler,
} from "../src/core";
import { eq, ok, throws, values } from "./helpers";

async function eachCanAccumulateWithoutLosingHistoricalEvents(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), total = d.store(0);
  const historical: string[] = [];
  class Counter extends Handler {
    run(ctx: Context): void {
      historical.push(`${ctx.before.read(source)}>${ctx.after.read(source)}:r${ctx.revision}`);
      ctx.update(total, v => v + 1);
    }
  }
  d.register(new Counter(), { on: { any: [source] }, delivery: "each" });
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  d.inline(ctx => ctx.set(source, 3));
  d.flush();
  eq(values(d, total), 3);
  eq(historical.join("|"), "0>1:r1|1>2:r2|2>3:r3");
}

async function eachReadsCurrentButHistoricalViewsStayFixed(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), threshold = d.store(10), audit = d.store(0);
  const results: string[] = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      results.push(`${ctx.after.read(source)}/${ctx.after.read(threshold)};current=${ctx.read(threshold)}`);
      ctx.update(audit, v => v + 1);
    }
  }
  d.register(new Observe(), { on: { any: [source] }, delivery: "each" });
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(threshold, 20));
  d.inline(ctx => ctx.set(source, 2));
  d.flush();
  eq(results.join("|"), "1/10;current=20|2/20;current=20");
  eq(values(d, audit), 2);
}

async function capacityRejectPreservesAtomicState(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), secondary = d.store(0);
  const received: number[] = [];
  class Observe extends Handler {
    run(ctx: Context): void { received.push(ctx.after.read(source)); }
  }
  const reg = d.register(new Observe(), {
    on: { any: [source] }, delivery: "each",
    buffer: { capacity: 2, overflow: "reject" },
  });
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  const revision = d.currentRevision;
  throws(() => d.inline(ctx => {
    ctx.set(source, 3);
    ctx.set(secondary, 99);
  }), BufferOverflowError);
  eq(d.currentRevision, revision);
  eq(values(d, source), 2);
  eq(values(d, secondary), 0);
  eq(reg.droppedJobs, 0);
  d.flush();
  eq(received.join(","), "1,2");
  d.inline(ctx => ctx.set(source, 3));
  d.flush();
  eq(received.join(","), "1,2,3");
}

async function oldestPolicyDropsOnlyItsOwnJobs(): Promise<void> {
  const d = new Dispatcher();
  const pulse = d.store(0);
  const received: number[] = [];
  class Observe extends Handler {
    run(ctx: Context): void { received.push(ctx.after.read(pulse)); }
  }
  const reg = d.register(new Observe(), {
    on: { any: [pulse] }, delivery: "each",
    buffer: { capacity: 2, overflow: "drop-oldest" },
  });
  for (let value = 1; value <= 4; value++) d.inline(ctx => ctx.set(pulse, value));
  d.flush();
  eq(received.join(","), "3,4");
  eq(reg.droppedJobs, 2);
}

async function newestPolicyKeepsEarlierJobs(): Promise<void> {
  const d = new Dispatcher();
  const pulse = d.store(0);
  const received: number[] = [];
  class Observe extends Handler {
    run(ctx: Context): void { received.push(ctx.after.read(pulse)); }
  }
  const reg = d.register(new Observe(), {
    on: { any: [pulse] }, delivery: "each",
    buffer: { capacity: 2, overflow: "drop-newest" },
  });
  for (let value = 1; value <= 4; value++) d.inline(ctx => ctx.set(pulse, value));
  d.flush();
  eq(received.join(","), "1,2");
  eq(reg.droppedJobs, 2);
  eq(values(d, pulse), 4);
}

async function defaultBufferIsBoundedAndLossless(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0);
  class Observe extends Handler { run(): void {} }
  d.register(new Observe(), { on: { any: [source] }, delivery: "each" });
  for (let n = 1; n <= 1024; n++) d.inline(ctx => ctx.set(source, n));
  throws(() => d.inline(ctx => ctx.set(source, 1025)), BufferOverflowError);
  eq(values(d, source), 1024);
  d.flush();
}

async function causalCycleStoppedAcrossSchedulerTurns(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({
    maxWavesPerTurn: 2,
    maxCausalWaves: 6,
    onError(error) { errors.push(error); },
  });
  const source = d.store(0);
  let runs = 0;
  class Endless extends Handler {
    run(ctx: Context): void { runs++; ctx.update(source, v => v + 1); }
  }
  d.register(new Endless(), { on: { any: [source] }, execution: "deferred" });
  d.inline(ctx => ctx.set(source, 1));
  // Allow multiple timer turns: the causal counter must not reset at each yield.
  await new Promise<void>(resolve => setTimeout(resolve, 90));
  eq(runs, 6);
  eq(values(d, source), 7);
  eq(errors.length, 1);
  ok(errors[0] instanceof FeedbackError);
  ok(String(errors[0]).includes("Causal chain"));
  d.flush(); // The offending lineage was removed, not left in the work queue.
  d.inline(ctx => ctx.set(source, 100)); // A distinct external root may still run.
  throws(() => d.flush(20), FeedbackError); // The new lineage has its own budget.
  d.flush(); // Its pending jobs have been discarded too.
}

async function unrelatedJobsSurviveErrorAndContinue(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxWavesPerTurn: 1, onError: error => errors.push(error) });
  const source = d.store(0);
  const seen: number[] = [];
  class Observe extends Handler {
    run(ctx: Context): void {
      const n = ctx.after.read(source);
      if (n === 1) throw new Error("intentional one-job failure");
      seen.push(n);
    }
  }
  d.register(new Observe(), { on: { any: [source] }, delivery: "each" });
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  await new Promise<void>(resolve => setTimeout(resolve, 90));
  eq(errors.length, 1);
  eq(seen.join(","), "2");
}

async function schedulerTurnBudgetIsNotRecursionError(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxWavesPerTurn: 1, maxCausalWaves: 64, onError: error => errors.push(error) });
  const input = d.store(0), output = d.store(0);
  class Observe extends Handler {
    run(ctx: Context): void { ctx.update(output, v => v + 1); }
  }
  d.register(new Observe(), { on: { any: [input] }, delivery: "each" });
  for (let i = 1; i <= 10; i++) d.inline(ctx => ctx.set(input, i));
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  eq(values(d, output), 10);
  eq(errors.length, 0);
}

async function latestCoalescesManyIndependentRootCauses(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ maxCausalWaves: 2, onError: e => errors.push(e) });
  const pulse = d.store<void>(undefined);
  let runs = 0;
  class Observe extends Handler { run(): void { runs++; } }
  d.register(new Observe(), { on: { any: [pulse] }, delivery: "latest" });
  for (let n = 0; n < 1000; n++) d.inline(ctx => ctx.set(pulse, undefined, { record: "always" }));
  d.flush();
  eq(runs, 1);
  eq(errors.length, 0);
}

export const schedulerCases: Array<[string, () => Promise<void>]> = [
  ["each accumulates safely from a fresh execution snapshot", eachCanAccumulateWithoutLosingHistoricalEvents],
  ["event snapshots remain historical while writes use current state", eachReadsCurrentButHistoricalViewsStayFixed],
  ["reject overflow preserves atomic commit", capacityRejectPreservesAtomicState],
  ["drop-oldest reports discarded events", oldestPolicyDropsOnlyItsOwnJobs],
  ["drop-newest reports discarded events", newestPolicyKeepsEarlierJobs],
  ["default each buffer is bounded and lossless", defaultBufferIsBoundedAndLossless],
  ["causal feedback stops across scheduler turns", causalCycleStoppedAcrossSchedulerTurns],
  ["scheduler resumes after a failed deferred handler", unrelatedJobsSurviveErrorAndContinue],
  ["normal scheduler yielding is not a causal loop", schedulerTurnBudgetIsNotRecursionError],
  ["latest merges many independent causal roots", latestCoalescesManyIndependentRootCauses],
];
