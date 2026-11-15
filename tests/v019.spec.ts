/** Nexus v0.1.9 boundary, config validation, teardown and Frida mock regressions. */
import { Context, Dispatcher, Handler, type ConflictRule } from "../src/core";
import { observeModule } from "../src/frida-adapter";
import type { FridaRuntime, FridaModule } from "../src/frida-adapter";
import { eq, ok, throws, values } from "./helpers";

async function submitCannotSurviveAbortedInline(): Promise<void> {
  const d = new Dispatcher(), parent = d.store(0), child = d.store(0);
  throws(() => d.inline(ctx => {
    ctx.set(parent, 1);
    d.submit(inner => inner.set(child, 2));
    throw new Error("abort");
  }));
  d.flush();
  eq(values(d, parent), 0);
  eq(values(d, child), 0);
  eq(d.currentRevision, 0);
}

async function submitCannotEscapeHandlerButPostCommitCan(): Promise<void> {
  const d = new Dispatcher(), trigger = d.store(0), target = d.store(0);
  class Wrong extends Handler {
    override run(ctx: Context): void {
      ctx.set(target, 10);
      void d.submit(next => next.set(target, 99));
    }
  }
  d.register(new Wrong(), { on: { any: [trigger] }, execution: "inline" });
  throws(() => d.inline(ctx => ctx.set(trigger, 1)));
  d.flush();
  eq(values(d, target), 0);
  const x = d.store(0);
  d.inline(ctx => ctx.effect(() => { void d.submit(next => next.set(x, 7)); }));
  d.flush();
  eq(values(d, x), 7);
}

async function conflictMutationCannotEscapeTransaction(): Promise<void> {
  const d = new Dispatcher(), s = d.store(0), source = d.store(0);
  class Noop extends Handler { override run(): void {} }
  const a = d.register(new Noop()), b = d.register(new Noop());
  const rule: ConflictRule = { store: s, between: [a,b], resolve: { strategy: "sequence", order: [a,b] }};
  throws(() => d.inline(ctx => {
    ctx.set(source, 1);
    d.conflicts.add(rule);
  }));
  eq(values(d, source), 0);
  eq(d.currentRevision, 0);
  const handle = d.conflicts.add(rule);
  throws(() => d.inline(() => handle.dispose()));
  eq(handle.active, true);
  handle.dispose();
  eq(handle.active, false);
  a.dispose();b.dispose();
}

async function invalidOptionsRejectBeforeRegistration(): Promise<void> {
  const d = new Dispatcher(), source = d.store(0);
  class Noop extends Handler { override run(): void {} }
  for (const options of [
    { on: {any:[source]}, delivery:"typo" },
    { on: {any:[source]}, execution:"other" },
    { on: {any:[source]}, initial:"yes" },
    { on: {any:[source], all:[source]} },
    { on: {any:"abc"} },
    { on: {any:[source]}, delivery:"each", buffer: {capacity: 2, overflow: "typo"} },
    { on: {any:[source]}, delivery:"each", buffer: "invalid" },
  ]) {
    const h = new Noop();
    throws(() => d.register(h, options as never), TypeError);
    const reg = d.register(h);
    reg.dispose();
  }
  const reg = d.register(new Noop(), {on: {any:[source]}, delivery:"each", buffer: {capacity:2, overflow:"reject"}});
  d.inline(ctx => ctx.set(source, 1));
  d.inline(ctx => ctx.set(source, 2));
  throws(() => d.inline(ctx => ctx.set(source, 3)));
  eq(values(d, source), 2);
  reg.dispose();
}

async function invalidDispatcherOptionsReject(): Promise<void> {
  throws(() => new Dispatcher({ conflictFallback:"surprise" } as never), TypeError);
  throws(() => new Dispatcher({ onError:"invalid" } as never), TypeError);
  const d = new Dispatcher();
  throws(() => d.store(1,{storage:"typo"} as never), TypeError);
  throws(() => d.store(1,{equals:1} as never), TypeError);
  const a = d.store(0);
  throws(() => d.inline(ctx => ctx.set(a, 8,{record:"typo"} as never)), TypeError);
  eq(values(d,a), 0);
  const reg1 = d.register(new class extends Handler {run(): void {} }()), reg2 = d.register(new class extends Handler {run():void{}}());
  throws(() => d.conflicts.add({store:a,between:[reg1,reg2],resolve:{strategy:"typo"}} as never),TypeError);
  reg1.dispose();reg2.dispose();
}

async function strictLifoPreservesCleanupDependencies(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  let alive = true, attempts = 0;
  const order: string[] = [];
  scope.cleanup(() => { order.push("release B"); alive = false; });
  scope.cleanup(() => {
    order.push("release A");
    if (++attempts === 1) throw new Error("A transient");
    ok(alive);
  });
  throws(() => scope.dispose(), AggregateError);
  eq(order.join(","), "release A");
  ok(alive);
  scope.dispose();
  eq(order.join(","), "release A,release A,release B");
  eq(alive, false);
}

async function strictLifoStopsBetweenHandlersToo(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope();
  let earlierRuns = 0, attempts = 0;
  class Earlier extends Handler { run():void{} onDispose():void{ earlierRuns++; } }
  class Later extends Handler { run():void{} onDispose():void{ if (++attempts === 1) throw Error("not ready"); }}
  const a = scope.register(new Earlier());
  const b = scope.register(new Later());
  throws(() => scope.dispose(), AggregateError);
  eq(earlierRuns, 0);
  eq(a.active, false); // all registrations are quiesced before cleanup
  eq(b.active, false);
  scope.dispose();
  eq(earlierRuns, 1);
}

async function asyncScopeCleanupIsNotSilentlyAccepted(): Promise<void> {
  const d = new Dispatcher(), scope = d.scope(), s = scope.store(4);
  let calls = 0;
  scope.cleanup((async () => { calls++; throw new Error("async cleanup failed"); }) as () => void);
  throws(() => scope.dispose(), AggregateError);
  eq(calls, 1);
  eq(values(d, s), 4); // a violation cannot complete cleanup or release Store
  await new Promise<void>(resolve => setTimeout(resolve, 5)); // rejected promise observed
}

async function asyncHandlerCleanupIsNotSilentlyAccepted(): Promise<void> {
  const d = new Dispatcher();
  let calls = 0;
  class Test extends Handler {
    run(): void {}
    onDispose(): void {
      calls++;
      if (calls === 1) return Promise.resolve() as unknown as void;
    }
  }
  const reg = d.register(new Test());
  throws(() => reg.dispose(), TypeError);
  eq(reg.cleanupComplete, false);
  reg.dispose();
  eq(calls, 2);
  eq(reg.cleanupComplete, true);
}

function testModule(name = "lib.so"): FridaModule {
  return {name,base: {toString: () => "0x1000"} as FridaModule["base"],size:100};
}

async function synchronousOnAddedFailureMustNotEscapeAttach(): Promise<void> {
  const errors: unknown[] = [];
  const d = new Dispatcher({onError: e => errors.push(e)}), scope = d.scope();
  let attached = 0, detached = 0;
  const runtime = {
    Process: { attachModuleObserver(callbacks: {onAdded(mod:FridaModule):void;onRemoved(mod:FridaModule):void}) {
      attached++;
      callbacks.onAdded(testModule()); // Frida synchronously invokes for preloaded modules
      return {detach() {detached++;}};
    }}
  } as FridaRuntime;
  observeModule(d,scope,runtime,"lib.so", () => { throw Error("load failed"); });
  eq(attached, 1);
  eq(errors.length, 1);
  eq((errors[0] as Error).message, "load failed");
  scope.dispose();
  eq(detached, 1);
}

async function synchronousOnAddedCleanupFailureRetainsChild(): Promise<void> {
  const errors: unknown[]=[];
  const d = new Dispatcher({onError: e => errors.push(e)}), root=d.scope();
  let cleanupAttempts=0, detach=0;
  const runtime = {Process:{attachModuleObserver(cb:{onAdded(mod:FridaModule):void;onRemoved(mod:FridaModule):void}) {
    cb.onAdded(testModule());
    return {detach() {detach++;}};
  }}} as FridaRuntime;
  observeModule(d,root,runtime,"lib.so",(_mod,child)=>{
    child.cleanup(() => { if (++cleanupAttempts === 1) throw Error("cleanup once failed"); });
    throw Error("onLoad failed");
  });
  eq(errors.length,1);
  ok(errors[0] instanceof AggregateError);
  eq(cleanupAttempts,1);
  root.dispose();
  eq(cleanupAttempts,2);
  eq(detach,1);
}

async function asyncOnLoadCannotEscapeFridaCallback(): Promise<void> {
  const errors:unknown[]=[];
  const d = new Dispatcher({onError:e=>errors.push(e)}), scope=d.scope();
  let detached=0;
  const runtime={Process:{attachModuleObserver(cb:{onAdded(m:FridaModule):void;onRemoved(m:FridaModule):void}) {
    cb.onAdded(testModule());
    return {detach(){detached++;}};
  }}} as FridaRuntime;
  observeModule(d,scope,runtime,"lib.so",(async()=>{ throw Error("async load failed"); }) as unknown as (m:FridaModule,s:ReturnType<Dispatcher["scope"]>)=>void);
  eq(errors.length,1);
  ok(errors[0] instanceof TypeError);
  scope.dispose();
  eq(detached,1);
  await new Promise<void>(resolve=>setTimeout(resolve,5));
}

async function onRemovedFailureIsReportedAndRetried(): Promise<void> {
  const errors:unknown[]=[];
  const d=new Dispatcher({onError: e=>errors.push(e)}), root=d.scope();
  let callbacks!: {onAdded(m:FridaModule):void;onRemoved(m:FridaModule):void};
  let attempts=0;
  const runtime={Process:{attachModuleObserver(cb:typeof callbacks) { callbacks=cb; return {detach() {}}; }}} as FridaRuntime;
  observeModule(d,root,runtime,"lib.so",(_mod,child)=>child.cleanup(()=>{
    if (++attempts === 1) throw Error("failed unload");
  }));
  callbacks.onAdded(testModule());
  callbacks.onRemoved(testModule());
  eq(errors.length,1);
  root.dispose();
  eq(attempts,2);
}

export const v019Cases: Array<[string, () => Promise<void>]> = [
  ["v019 submit cannot escape aborted inline",submitCannotSurviveAbortedInline],
  ["v019 submit forbidden inside Handler; effect may schedule",submitCannotEscapeHandlerButPostCommitCan],
  ["v019 conflict rules cannot mutate in uncommitted transaction",conflictMutationCannotEscapeTransaction],
  ["v019 invalid registration options fail before commit",invalidOptionsRejectBeforeRegistration],
  ["v019 invalid dispatcher and conflict strategies rejected",invalidDispatcherOptionsReject],
  ["v019 strict LIFO preserves cleanup dependencies",strictLifoPreservesCleanupDependencies],
  ["v019 strict LIFO also preserves Handler order",strictLifoStopsBetweenHandlersToo],
  ["v019 async Scope.cleanup is rejected",asyncScopeCleanupIsNotSilentlyAccepted],
  ["v019 async Handler.onDispose is rejected",asyncHandlerCleanupIsNotSilentlyAccepted],
  ["v019 synchronous Frida onAdded failures stay inside callback",synchronousOnAddedFailureMustNotEscapeAttach],
  ["v019 failed initial load cleanup remains owned",synchronousOnAddedCleanupFailureRetainsChild],
  ["v019 failed onRemoved cleanup remains retryable",onRemovedFailureIsReportedAndRetried],
  ["v019 async onLoad cannot escape foreign callback",asyncOnLoadCannotEscapeFridaCallback],
];
