import { Dispatcher } from "../src/core";
import { attachJavaHook, attachIl2CppHook, ManagedHookFailure } from "../src/frida";
import type { JavaBridgeLike, JavaMethodLike, Il2CppBridgeLike, Il2CppMethodLike } from "../src/frida";
import { eq, ok, throws } from "./helpers";

function javaFixture() {
  let implementation: JavaMethodLike["implementation"] = null;
  const handle = { toString: () => "0xa1b2" };
  const real = (_receiver: unknown, ...args: any[]): any => args[0] ?? 2;
  const freshWrapper = (): JavaMethodLike => ({
    handle,
    get implementation() { return implementation; },
    set implementation(fn) { implementation = fn; },
    call: real,
  });
  let performances = 0;
  const java: JavaBridgeLike = {
    perform(fn) { performances++; fn(); },
    use() { return { selected: { overload: () => freshWrapper() } }; },
  };
  const call = (arg?: unknown): unknown => (implementation ?? (function (this: unknown, ...args: any[]) { return real(this, ...args); })).call({}, arg);
  return { java, call, get implementation() { return implementation; }, get performances() { return performances; } };
}

function il2cppFixture() {
  const method: Il2CppMethodLike = {
    implementation: null,
    invoke: (...args: unknown[]) => args[0],
    revert() { method.implementation = null; },
  };
  const il2cpp: Il2CppBridgeLike = {
    perform(fn) { fn(); },
    domain: { assembly: () => ({ image: { class: () => ({ method: () => method }) } }) },
  };
  return { method, il2cpp };
}

const basic = { className: "C", methodName: "selected", overload: [] };
const iBasic = { assembly: "A", className: "C", methodName: "M" };

const cases: Array<[string, () => Promise<void> | void]> = [
  ["Java rejects second hook through a different wrapper of the same native method", async () => {
    const d = new Dispatcher(), s1 = d.scope(), s2 = d.scope(), f = javaFixture();
    const a = attachJavaHook(d, s1, f.java, { ...basic, callbacks: { before(_ctx, call) { call.replaceArg(0, 11); } } });
    await a.ready;
    const first = f.implementation;
    const b = attachJavaHook(d, s2, f.java, { ...basic, callbacks: {} });
    let failed = false; try { await b.ready; } catch (error) { failed = /already has a Nexus hook/.test(String(error)); }
    ok(failed);
    eq(f.implementation, first);
    eq(f.call(5), 11);
    s1.dispose();
    eq(f.implementation, null);
    const c = attachJavaHook(d, s2, f.java, { ...basic, callbacks: {} });
    await c.ready;
    s2.dispose();
    eq(f.implementation, null);
  }],
  ["Java validation rejects null callbacks before Java.perform", () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    throws(() => attachJavaHook(d, s, f.java, { ...basic, callbacks: null as any }), TypeError);
    eq(f.performances, 0);
    s.dispose();
  }],
  ["Java validation rejects malformed callbacks, signature and failure policy", () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    throws(() => attachJavaHook(d, s, f.java, { ...basic, callbacks: { before: 4 } as any }), TypeError);
    throws(() => attachJavaHook(d, s, f.java, { ...basic, overload: [3] as any, callbacks: {} }), TypeError);
    throws(() => attachJavaHook(d, s, f.java, { ...basic, failure: "ignore" as any, callbacks: {} }), TypeError);
    eq(f.performances, 0);
    s.dispose();
  }],
  ["IL2CPP validation happens before perform", () => {
    const d = new Dispatcher(), s = d.scope(), f = il2cppFixture(); let calls = 0;
    const runtime: Il2CppBridgeLike = { ...f.il2cpp, perform(fn) { calls++; fn(); } };
    throws(() => attachIl2CppHook(d, s, runtime, { ...iBasic, callbacks: null as any }), TypeError);
    throws(() => attachIl2CppHook(d, s, runtime, { ...iBasic, callbacks: { after: true } as any }), TypeError);
    throws(() => attachIl2CppHook(d, s, runtime, { ...iBasic, overload: [null] as any, callbacks: {} }), TypeError);
    eq(calls, 0);
    s.dispose();
  }],
  ["Java callback object is snapshotted before installation", async () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    let observed = 0;
    const callbacks = { after(_ctx: any, call: any) { observed++; call.replaceResult(7); } };
    const h = attachJavaHook(d, s, f.java, { ...basic, callbacks });
    await h.ready;
    callbacks.after = () => { throw new Error("mutated"); };
    eq(f.call(2), 7);
    eq(observed, 1);
    s.dispose();
  }],
  ["Java failure propagate prevents original invocation after failed before", async () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    const h = attachJavaHook(d, s, f.java, { ...basic, failure: "propagate", callbacks: { before() { throw new Error("failed guard"); } } });
    await h.ready;
    let caught: unknown;
    try { f.call(3); } catch (error) { caught = error; }
    ok(caught instanceof ManagedHookFailure);
    eq((caught as ManagedHookFailure).phase, "before");
    eq((caught as ManagedHookFailure).originalCalled, false);
    s.dispose();
  }],
  ["Java failure passthrough remains compatible with v0.1.16", async () => {
    const errors: unknown[] = []; const d = new Dispatcher({ onError: e => errors.push(e) });
    const s = d.scope(), f = javaFixture();
    await attachJavaHook(d, s, f.java, { ...basic, callbacks: { before() { throw new Error("fail"); } } }).ready;
    eq(f.call(9), 9);
    eq(errors.length, 1);
    s.dispose();
  }],
  ["Java failure propagate reports after original was already invoked", async () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    await attachJavaHook(d, s, f.java, { ...basic, failure: "propagate", callbacks: { after() { throw new Error("fail after"); } } }).ready;
    let caught: unknown;
    try { f.call(9); } catch (error) { caught = error; }
    ok(caught instanceof ManagedHookFailure);
    eq((caught as ManagedHookFailure).phase, "after");
    eq((caught as ManagedHookFailure).originalCalled, true);
    s.dispose();
  }],
  ["IL2CPP supports propagate failure and staged replaceArg", async () => {
    const d = new Dispatcher(), s = d.scope(), f = il2cppFixture();
    await attachIl2CppHook(d, s, f.il2cpp, { ...iBasic, failure: "propagate", callbacks: { before(_ctx, call) { call.replaceArg(0, 8); } } }).ready;
    const result = f.method.implementation!.call({}, 5);
    eq(result, 8);
    s.dispose();
  }],
  ["Nested object mutations remain external side effects and are NOT rolled back", async () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    const obj = { health: 100 };
    await attachJavaHook(d, s, f.java, { ...basic, failure: "propagate", callbacks: { before(_ctx, call) { (call.args[0] as any).health = 999; throw new Error("fail"); } } }).ready;
    throws(() => f.call(obj), ManagedHookFailure);
    eq(obj.health, 999); // Intentional: external mutation cannot be rolled back
    s.dispose();
  }],
  ["Top-level replaceArg does not leak into original on failed before", async () => {
    const errors: unknown[] = []; const d = new Dispatcher({ onError: e => errors.push(e) });
    const s = d.scope(), f = javaFixture(), original = { health: 100 };
    await attachJavaHook(d, s, f.java, { ...basic, callbacks: { before(_ctx, call) { call.replaceArg(0, { health: 999 }); throw new Error("abort"); } } }).ready;
    eq(f.call(original), original);
    eq(original.health, 100);
    eq(errors.length, 1);
    s.dispose();
  }],
  ["Reentrant Java hook can fail closed instead of silently calling original", async () => {
    const d = new Dispatcher(), s = d.scope(), f = javaFixture();
    let before = 0;
    await attachJavaHook(d, s, f.java, { ...basic, failure: "propagate", callbacks: {
      before() { before++; }
    } }).ready;
    d.inline(() => {
      let error: unknown;
      try { f.call(5); } catch (e) { error = e; }
      ok(error instanceof ManagedHookFailure);
      eq((error as ManagedHookFailure).phase, "before");
      eq((error as ManagedHookFailure).originalCalled, false);
    });
    eq(before, 0);
    s.dispose();
  }],
  ["IL2CPP hook callbacks and failure config remain stable after mutation", async () => {
    const d = new Dispatcher(), s = d.scope(), f = il2cppFixture();
    const callbacks = { before(_ctx: any, call: any) { call.replaceArg(0, 12); } };
    const options = { ...iBasic, callbacks, failure: "propagate" as const };
    await attachIl2CppHook(d, s, f.il2cpp, options).ready;
    callbacks.before = () => { throw new Error("mutated"); };
    eq(f.method.implementation!.call({}, 2), 12);
    s.dispose();
  }],
  ["Java hook identity stays claimed if first Scope cleanup fails", async () => {
    const d = new Dispatcher(), s1 = d.scope(), s2 = d.scope(), f = javaFixture();
    await attachJavaHook(d, s1, f.java, { ...basic, callbacks: {} }).ready;
    const displaced = f.implementation;
    // Model a third-party override. Failed disposal must retain claim.
    // The fixture's implementation must be replaced through the live wrapper;
    // a new wrapper object references the same backing native method.
    const method = f.java.use("C").selected as { overload(): JavaMethodLike };
    const over = method.overload();
    over.implementation = () => 999;
    throws(() => s1.dispose());
    let rejected = false;
    try { await attachJavaHook(d, s2, f.java, { ...basic, callbacks: {} }).ready; } catch { rejected = true; }
    ok(rejected);
    over.implementation = displaced;
    s1.dispose();
    await attachJavaHook(d, s2, f.java, { ...basic, callbacks: {} }).ready;
    s2.dispose();
  }],
];

export const v0117Cases = cases.map(([name, run]) => [`v0.1.17 ${name}`, run] as const);
