/** v0.1.16 Java / IL2CPP bridge adapters. All runtime tests use explicit mocks;
 * they do NOT establish compatibility with any real Android/Unity process.
 */
import { Context, Dispatcher, Handler } from "../src/core";
import { attachJavaHook, attachIl2CppHook } from "../src/frida";
import type { JavaBridgeLike, JavaMethodLike, Il2CppBridgeLike, Il2CppMethodLike } from "../src/frida";
import { eq, ok, throws, values } from "./helpers";

class JavaMock {
  readonly method: JavaMethodLike;
  readonly bridge: JavaBridgeLike;
  pending: (() => void) | undefined;
  readonly calls: string[] = [];
  constructor(impl: (receiver: unknown, ...args: any[]) => unknown, deferred = false) {
    this.method = { implementation: null, call: (receiver, ...args) => impl(receiver, ...args) };
    this.bridge = {
      perform: fn => { this.calls.push("perform"); if (deferred) this.pending = fn; else fn(); },
      use: name => {
        this.calls.push("use:" + name);
        return { method: { overload: (...params: string[]) => {
          this.calls.push("overload:" + params.join(",")); return this.method;
        } } };
      },
    };
  }
  call(receiver: unknown, ...args: unknown[]): unknown {
    return (this.method.implementation ?? ((...a: any[]) => this.method.call(receiver, ...a))).apply(receiver, args);
  }
}

class Il2CppMock {
  readonly method: Il2CppMethodLike;
  readonly bridge: Il2CppBridgeLike;
  pending: (() => void) | undefined;
  readonly calls: string[] = [];
  constructor(original: (...args: number[]) => number, deferred = false) {
    const current = this;
    this.method = {
      implementation: null,
      invoke(...args: any[]) { current.calls.push("original"); return original(...args); },
      revert() { current.calls.push("revert"); current.method.implementation = null; },
      overload(...types: string[]) { current.calls.push("overload:" + types.join(",")); return current.method; },
    };
    this.bridge = {
      perform: fn => { this.calls.push("perform"); if (deferred) this.pending = fn; else fn(); },
      domain: { assembly: name => { this.calls.push("assembly:" + name); return { image: { class: className => {
        this.calls.push("class:" + className);
        return { method: methodName => { this.calls.push("method:" + methodName); return this.method; } };
      } } }; } },
    };
  }
  call(receiver: unknown, ...args: number[]): number {
    return ((this.method.implementation ?? function (...x: number[]) { return originalUnused(...x); }) as (...x: number[]) => number).apply(receiver, args);
    function originalUnused(..._x: number[]): never { throw new Error("not installed"); }
  }
}

const cases: Array<[string, () => Promise<void> | void]> = [
  ["java before/after can mutate args and return synchronously", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const trace: string[] = [];
    const m = new JavaMock((_this, n: number) => { trace.push("original:" + n); return n * 2; });
    const h = attachJavaHook<[number], number>(d, scope, m.bridge, {
      className: "com.game.Player", methodName: "method", overload: ["int"],
      callbacks: {
        before(_ctx, call) { trace.push("before"); call.args[0] += 3; },
        after(_ctx, call) { trace.push("after:" + call.result); call.replaceResult(call.result! + 1); },
      },
    });
    await h.ready; eq(h.active, true);
    eq(m.call({}, 2), 11);
    eq(trace.join(","), "before,original:5,after:10");
    scope.dispose(); eq(h.active, false); eq(m.call({}, 2), 4);
  }],
  ["java before may suppress original and publish reactive state", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const store = scope.store(0);
    const trace: string[] = []; const m = new JavaMock(() => { trace.push("original"); return 8; });
    class Observe extends Handler { run(ctx: Context) { trace.push("reaction:" + ctx.read(store)); } }
    scope.register(new Observe(), { on: { any: [store] }, execution: "inline" });
    await attachJavaHook<[], number>(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [],
      callbacks: { before(ctx, call) { ctx.set(store, 7); call.skipOriginal(0); } },
    }).ready;
    eq(m.call({}), 0); eq(values(d, store), 7); eq(trace.join(","), "reaction:7");
    scope.dispose();
  }],
  ["java detached or failed scope cleanup always passthrough", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 5);
    let used = 0;
    await attachJavaHook<[], number>(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [], callbacks: { after(_ctx, call) { used++; call.replaceResult(9); } },
    }).ready;
    eq(m.call({}), 9); scope.dispose(); eq(m.call({}), 5); eq(used, 1);
  }],
  ["java deferred perform honors cancellation before initialization", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 3, true);
    const h = attachJavaHook(d, scope, m.bridge, { className: "X", methodName: "method", overload: [], callbacks: {} });
    scope.dispose(); m.pending!(); await h.ready;
    eq(m.method.implementation, null); eq(h.active, false); eq(m.calls.includes("use:X"), false);
  }],
  ["java installation rejects with ready when overload lookup fails", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 1);
    const h = attachJavaHook(d, scope, { ...m.bridge, use: () => ({}) }, { className: "X", methodName: "missing", overload: [], callbacks: {} });
    let failed = false; try { await h.ready; } catch { failed = true; }
    eq(failed, true); scope.dispose();
  }],
  ["java restoration keeps previous implementation intact", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 2);
    const previous = function () { return 3; }; m.method.implementation = previous;
    await attachJavaHook(d, scope, m.bridge, { className: "X", methodName: "method", overload: [], callbacks: {} }).ready;
    scope.dispose(); eq(m.method.implementation, previous);
  }],
  ["java rejects replacement changed by external owner during disposal", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 4);
    await attachJavaHook(d, scope, m.bridge, { className: "X", methodName: "method", overload: [], callbacks: {} }).ready;
    m.method.implementation = () => 9;
    throws(() => scope.dispose());
    eq(m.method.implementation!(), 9);
    m.method.implementation = null; // external code must restore replaced implementation or owner must retry manually
  }],
  ["il2cpp overload, original, replacement, revert", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new Il2CppMock(n => n * 3);
    const h = attachIl2CppHook<[number], number>(d, scope, m.bridge, {
      assembly: "Assembly-CSharp", className: "Game.Player", methodName: "Multiply", overload: ["System.Int32"],
      callbacks: { before(_ctx, call) { call.args[0] += 2; }, after(_ctx, call) { call.replaceResult(call.result! + 1); } },
    });
    await h.ready; eq(h.active, true);
    const receiver = { method: () => m.method };
    eq(m.call(receiver, 3), 16);
    ok(m.calls.includes("overload:System.Int32"));
    scope.dispose(); eq(h.active, false); ok(m.calls.includes("revert"));
  }],
  ["il2cpp skipOriginal returns immediately", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new Il2CppMock(() => { throw new Error("must not invoke"); });
    await attachIl2CppHook<[number], number>(d, scope, m.bridge, {
      assembly: "A", className: "C", methodName: "M", callbacks: { before(_ctx, call) { call.skipOriginal(42); } },
    }).ready;
    eq(m.call({}, 4), 42); scope.dispose();
  }],
  ["il2cpp deferred perform honors scope closure", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new Il2CppMock(n => n, true);
    const h = attachIl2CppHook(d, scope, m.bridge, { assembly: "A", className: "C", methodName: "M", callbacks: {} });
    scope.dispose(); m.pending!(); await h.ready;
    eq(m.method.implementation, null); eq(h.active, false);
  }],
  ["il2cpp refuses to override another implementation", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new Il2CppMock(n => n);
    m.method.implementation = () => 2;
    const h = attachIl2CppHook(d, scope, m.bridge, { assembly: "A", className: "C", methodName: "M", callbacks: {} });
    let failed = false; try { await h.ready; } catch { failed = true; }
    eq(failed, true); eq(m.method.implementation!(), 2); scope.dispose();
  }],
  ["il2cpp perform rejected promise is exposed through ready", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new Il2CppMock(n => n);
    const broken: Il2CppBridgeLike = { ...m.bridge, perform: () => Promise.reject(new Error("runtime unavailable")) };
    const h = attachIl2CppHook(d, scope, broken, { assembly: "A", className: "C", methodName: "M", callbacks: {} });
    let failed = false; try { await h.ready; } catch { failed = true; }
    eq(failed, true); scope.dispose();
  }],
  ["managed callbacks may not return Promise", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 3);
    await attachJavaHook(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [],
      callbacks: { before: (() => Promise.resolve()) as any },
    }).ready;
    // Error is diagnosed rather than allowed to escape into JVM/IL2CPP.
    // The default reporter logs it, while the original implementation runs.
    eq(m.call({}), 3); scope.dispose();
  }],
  ["failed before callback falls back to untouched arguments", async () => {
    const errors: unknown[] = []; const d = new Dispatcher({ onError: error => { errors.push(error); } });
    const scope = d.scope(); const m = new JavaMock((_obj, value: number) => value * 4);
    await attachJavaHook<[number], number>(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [], callbacks: {
        before(_ctx, call) { call.args[0] = 100; throw new Error("before failed"); },
      },
    }).ready;
    eq(m.call({}, 3), 12); eq(errors.length, 1); scope.dispose();
  }],
  ["failed after callback cannot leak speculative return replacement", async () => {
    const errors: unknown[] = []; const d = new Dispatcher({ onError: error => { errors.push(error); } });
    const scope = d.scope(); const m = new JavaMock((_obj, value: number) => value * 4);
    await attachJavaHook<[number], number>(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [], callbacks: {
        after(_ctx, call) { call.replaceResult(999); throw new Error("after failed"); },
      },
    }).ready;
    eq(m.call({}, 3), 12); eq(errors.length, 1); scope.dispose();
  }],
  ["managed call cannot be used after callback returns", async () => {
    const d = new Dispatcher(); const scope = d.scope(); const m = new JavaMock(() => 3);
    let ref: any;
    await attachJavaHook(d, scope, m.bridge, {
      className: "X", methodName: "method", overload: [],
      callbacks: { before(_ctx, call) { ref = call; } },
    }).ready;
    eq(m.call({}), 3); throws(() => ref.skipOriginal(8)); scope.dispose();
  }],
];

export const v0116Cases = cases.map(([name, run]) => [`v0.1.16 ${name}`, run] as const);
