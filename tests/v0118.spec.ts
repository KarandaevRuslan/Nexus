import {
  BufferOverflowError, Context, Dispatcher, Handler, PostCommitReactionError,
  type ReadContext,
} from "../src/core";
import { eq, ok, throws, values } from "./helpers";

async function requestedHandlerRunsAfterParentCommit(): Promise<void> {
  const d = new Dispatcher();
  const trigger = d.store(0), input = d.store(0), derived = d.store(0);
  const observed: number[] = [];
  class B extends Handler {
    run(ctx: Context): void { observed.push(ctx.read(input)); ctx.set(derived, ctx.read(input) * 2); }
  }
  const b = d.register(new B(), { execution: "inline" });
  class A extends Handler {
    run(ctx: Context): void { ctx.set(input, 15); ctx.request(b); }
  }
  d.register(new A(), { on: { any: [trigger] }, execution: "inline" });
  d.inline(ctx => ctx.set(trigger, 1));
  eq(values(d, derived), 30);
  eq(observed.join(","), "15"); // B observes A's committed Store, not speculative draft.
}

async function requestIsRolledBackWithFailedHandler(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: e => errors.push(e) });
  const source = d.store(0), result = d.store(0);
  class B extends Handler { run(ctx: Context): void { ctx.set(result, 99); } }
  const b = d.register(new B(), { execution: "inline" });
  class A extends Handler {
    run(ctx: Context): void {
      ctx.request(b);
      ctx.set(result, 10);
      throw new Error("aborted");
    }
  }
  d.register(new A(), { on: { any: [source] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
  eq(values(d, result), 0);
}

async function requestFromPlainTransactionDoesNotNeedStoreChange(): Promise<void> {
  const d = new Dispatcher();
  const result = d.store(0);
  class B extends Handler {
    run(ctx: Context): void { ctx.update(result, n => n + 1); }
  }
  const b = d.register(new B(), { execution: "inline", delivery: "each" });
  const oldRevision = d.currentRevision;
  d.inline(ctx => { ctx.request(b); ctx.request(b); });
  eq(values(d, result), 2);
  ok(d.currentRevision >= oldRevision + 1);
}

async function eventCarriesPayloadAndSnapshot(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<{ amount: number }>(), state = d.store(1);
  const received: string[] = [];
  class Observer extends Handler {
    when(ctx: ReadContext): boolean { return (ctx.event(evt)?.value.amount ?? -1) > 0; }
    run(ctx: Context): void {
      received.push(`${ctx.event(evt)?.value.amount}:${ctx.read(state)}`);
    }
  }
  d.register(new Observer(), { on: { any: [evt] }, execution: "deferred", delivery: "each" });
  const input = { amount: 7 };
  d.inline(ctx => { ctx.set(state, 4); ctx.emit(evt, input); });
  input.amount = 1000;
  d.flush();
  eq(received.join(","), "7:4");
}

async function undefinedPayloadIsDistinguishedFromAbsentEvent(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<undefined>();
  const result: string[] = [];
  class Observer extends Handler {
    run(ctx: Context): void { result.push(ctx.event(evt) ? "present" : "absent"); }
  }
  const reg = d.register(new Observer(), { on: { any: [evt] }, execution: "inline", delivery: "each" });
  d.inline(ctx => ctx.emit(evt, undefined));
  d.request(reg);
  eq(result.join(","), "present,absent");
}

async function separateEventOccurrencesAreNotCoalescedInEachMode(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>();
  const received: number[] = [];
  class Observer extends Handler {
    run(ctx: Context): void { received.push(ctx.event(evt)!.value); }
  }
  d.register(new Observer(), { on: { any: [evt] }, delivery: "each" });
  d.inline(ctx => { ctx.emit(evt, 1); ctx.emit(evt, 2); ctx.emit(evt, 3); });
  d.flush();
  eq(received.join(","), "1,2,3");
}

async function latestEventDeliversLastOccurrence(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>();
  const received: number[] = [];
  class Observer extends Handler {
    run(ctx: Context): void { received.push(ctx.event(evt)!.value); }
  }
  d.register(new Observer(), { on: { any: [evt] }, delivery: "latest" });
  d.inline(ctx => { ctx.emit(evt, 1); ctx.emit(evt, 2); ctx.emit(evt, 3); });
  d.flush();
  eq(received.join(","), "3");
}

async function eventBufferRejectsBeforeAnyStoreChange(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>(), count = d.store(0);
  class Observer extends Handler { run(): void {} }
  d.register(new Observer(), {
    on: { any: [evt] }, delivery: "each", buffer: { capacity: 2, overflow: "reject" },
  });
  const initial = d.currentRevision;
  throws(() => d.inline(ctx => {
    ctx.set(count, 99);
    ctx.emit(evt, 1);
    ctx.emit(evt, 2);
    ctx.emit(evt, 3);
  }), BufferOverflowError);
  eq(values(d, count), 0);
  eq(d.currentRevision, initial);
  d.inline(ctx => { ctx.emit(evt, 1); ctx.emit(evt, 2); });
  d.flush();
}

async function eventAndStoreCapacityAreCheckedTogether(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>(), count = d.store(0);
  class Observer extends Handler { run(): void {} }
  d.register(new Observer(), {
    on: { any: [evt, count] }, delivery: "each", buffer: { capacity: 1 },
  });
  throws(() => d.inline(ctx => { ctx.set(count, 1); ctx.emit(evt, 42); }), BufferOverflowError);
  eq(values(d, count), 0);
}

async function eventsCannotAppearInOnAll(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>();
  class Observer extends Handler { run(): void {} }
  throws(() => d.register(new Observer(), { on: { all: [evt] } as any }), Error);
}

async function foreignAndDisposedEventsAreRejected(): Promise<void> {
  const d = new Dispatcher(), other = new Dispatcher();
  const evt = d.event<number>();
  throws(() => other.inline(ctx => ctx.emit(evt, 4)), Error);
  d.unregisterEvent(evt);
  throws(() => d.inline(ctx => ctx.emit(evt, 4)), Error);
}

async function scopeOwnsEvents(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const evt = scope.event<number>();
  const seen: number[] = [];
  class Observer extends Handler { run(ctx: Context): void { seen.push(ctx.event(evt)!.value); } }
  scope.register(new Observer(), { on: { any: [evt] }, execution: "inline" });
  d.inline(ctx => ctx.emit(evt, 11));
  eq(seen[0], 11);
  scope.dispose();
  throws(() => d.inline(ctx => ctx.emit(evt, 12)), Error);
}

async function submitAndWaitTracksDeferredDescendants(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<number>(), accumulator = d.store(0), finished = d.store(false);
  class Step extends Handler {
    run(ctx: Context): void {
      const occurrence = ctx.event(evt);
      if (occurrence) ctx.set(accumulator, occurrence.value * 2);
    }
  }
  class Final extends Handler {
    run(ctx: Context): void { ctx.set(finished, true); }
  }
  d.register(new Step(), { on: { any: [evt] }, execution: "deferred", delivery: "each" });
  d.register(new Final(), { on: { any: [accumulator] }, execution: "deferred" });
  const value = await d.submitAndWait(ctx => { ctx.emit(evt, 6); return "accepted"; });
  eq(value, "accepted");
  eq(values(d, accumulator), 12);
  eq(values(d, finished), true);
}

async function submitAndWaitTracksContextRequests(): Promise<void> {
  const d = new Dispatcher();
  const number = d.store(0);
  class B extends Handler { run(ctx: Context): void { ctx.set(number, 42); } }
  const reg = d.register(new B(), { execution: "deferred" });
  await d.submitAndWait(ctx => ctx.request(reg));
  eq(values(d, number), 42);
}

async function submitAndWaitRejectsFailedDescendant(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({ onError: err => { errors.push(err); } });
  const source = d.store(0);
  class Bad extends Handler { run(): void { throw new Error("descendant failed"); } }
  d.register(new Bad(), { on: { any: [source] }, execution: "deferred" });
  let caught: unknown;
  try { await d.submitAndWait(ctx => ctx.set(source, 10)); }
  catch (error) { caught = error; }
  ok(caught instanceof Error && caught.message.includes("descendant failed"));
  eq(values(d, source), 10); // parent is already committed
  ok(errors.length >= 1);
}

async function sequenceReplayPublishesEventOnlyOnce(): Promise<void> {
  const d = new Dispatcher();
  const trigger = d.store(0), shared = d.store(0), evt = d.event<string>();
  const received: string[] = [];
  class A extends Handler {
    run(ctx: Context): void { ctx.set(shared, 1); ctx.emit(evt, "A"); }
  }
  class B extends Handler {
    run(ctx: Context): void { ctx.set(shared, 2); ctx.emit(evt, "B"); }
  }
  class Listener extends Handler {
    run(ctx: Context): void { received.push(ctx.event(evt)!.value); }
  }
  const a = d.register(new A(), { on: { any: [trigger] }, execution: "inline" });
  const b = d.register(new B(), { on: { any: [trigger] }, execution: "inline" });
  d.conflicts.add({ store: shared, between: [a, b], resolve: { strategy: "sequence", order: [a, b] } });
  d.register(new Listener(), { on: { any: [evt] }, execution: "inline", delivery: "each" });
  d.inline(ctx => ctx.set(trigger, 1));
  eq(received.join(","), "A,B");
  eq(values(d, shared), 2);
}

async function requestCapacityIsCheckedBeforeCommit(): Promise<void> {
  const d = new Dispatcher();
  const state = d.store(0);
  class B extends Handler { run(): void {} }
  const reg = d.register(new B(), { delivery: "each", buffer: { capacity: 1 } });
  throws(() => d.inline(ctx => {
    ctx.set(state, 999);
    ctx.request(reg);
    ctx.request(reg);
  }), BufferOverflowError);
  eq(values(d, state), 0);
}

async function submitAndWaitFollowsCommandsFromPostCommitEffects(): Promise<void> {
  const d = new Dispatcher();
  const source = d.store(0), finished = d.store(false);
  class EnqueueFollowup extends Handler {
    run(ctx: Context): void {
      ctx.effect(() => { void d.submit(next => next.set(finished, true)); });
    }
  }
  d.register(new EnqueueFollowup(), { on: { any: [source] }, execution: "deferred" });
  await d.submitAndWait(ctx => ctx.set(source, 1));
  eq(values(d, finished), true);
}

async function scopedSubmitAndWaitCancelsOnDispose(): Promise<void> {
  const d = new Dispatcher();
  const scope = d.scope();
  const state = d.store(0);
  const promise = scope.submitAndWait(ctx => { ctx.set(state, 10); });
  scope.dispose();
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  ok(caught instanceof Error);
  eq(values(d, state), 0);
}

async function eventPayloadCannotBeChangedAfterEmission(): Promise<void> {
  const d = new Dispatcher();
  const evt = d.event<{ nested: { number: number } }>();
  const received: number[] = [];
  class Observer extends Handler { run(ctx: Context): void { received.push(ctx.event(evt)!.value.nested.number); } }
  d.register(new Observer(), { on: { any: [evt] }, delivery: "each" });
  const payload = { nested: { number: 10 } };
  d.inline(ctx => ctx.emit(evt, payload));
  payload.nested.number = 20;
  d.flush();
  eq(received[0], 10);
}

async function reusableWorkflowCompletesViaEventsAndRequests(): Promise<void> {
  const { createDamageWorkflow } = await import("../examples/events-workflow");
  const app = createDamageWorkflow(100);
  try {
    const first = await app.apply(15);
    const second = await app.apply(25);
    eq(first.health, 85);
    eq(second.health, 60);
    eq(first.audit.length, 1);
    eq(second.audit.length, 2);
  } finally { app.dispose(); }
}

export const v0118Cases: [string, () => Promise<void>][] = [
  ["v0.1.18 ctx.request runs Handler only after parent's successful Commit", requestedHandlerRunsAfterParentCommit],
  ["v0.1.18 staged Handler request is rolled back on failure", requestIsRolledBackWithFailedHandler],
  ["v0.1.18 request-only transaction can schedule two jobs", requestFromPlainTransactionDoesNotNeedStoreChange],
  ["v0.1.18 Event carries immutable payload and sees committed state", eventCarriesPayloadAndSnapshot],
  ["v0.1.18 Event with undefined payload is distinguishable from no event", undefinedPayloadIsDistinguishedFromAbsentEvent],
  ["v0.1.18 each preserves separately emitted occurrences", separateEventOccurrencesAreNotCoalescedInEachMode],
  ["v0.1.18 latest coalesces payload to final occurrence", latestEventDeliversLastOccurrence],
  ["v0.1.18 event overflow rejects before Store Commit", eventBufferRejectsBeforeAnyStoreChange],
  ["v0.1.18 Store + Event capacity is preflighted as a batch", eventAndStoreCapacityAreCheckedTogether],
  ["v0.1.18 on.all deliberately excludes Event", eventsCannotAppearInOnAll],
  ["v0.1.18 foreign/disposed Event is invalid", foreignAndDisposedEventsAreRejected],
  ["v0.1.18 Scope owns event registration lifetime", scopeOwnsEvents],
  ["v0.1.18 submitAndWait awaits deferred causal descendants", submitAndWaitTracksDeferredDescendants],
  ["v0.1.18 submitAndWait awaits staged Handler requests", submitAndWaitTracksContextRequests],
  ["v0.1.18 submitAndWait rejects failed descendants after durable parent Commit", submitAndWaitRejectsFailedDescendant],
  ["v0.1.18 sequence replay publishes each event exactly once", sequenceReplayPublishesEventOnlyOnce],
  ["v0.1.18 request batch overflows atomically", requestCapacityIsCheckedBeforeCommit],
  ["v0.1.18 causal wait tracks commands spawned in postcommit effects", submitAndWaitFollowsCommandsFromPostCommitEffects],
  ["v0.1.18 Scope-owned causal command cancels before start", scopedSubmitAndWaitCancelsOnDispose],
  ["v0.1.18 Event deep snapshot is detached at emission time", eventPayloadCannotBeChangedAfterEmission],
  ["v0.1.18 reusable workflow emits typed events and requests a Handler", reusableWorkflowCompletesViaEventsAndRequests],
];
