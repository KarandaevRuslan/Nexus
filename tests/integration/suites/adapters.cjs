'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 44-53: Bridge mocks and invocation lifetimes.
    test('frida', 'Java before/after edits arguments/results and updates Nexus Store', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = javaFixture(), observed = d.store(0), audit = [];
        d.register(handler(ctx => audit.push(ctx.read(observed))), { on: { any: [observed] }, execution: 'inline' });
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: {
                before(ctx, call) { call.replaceArg(0, call.args[0] + 3); ctx.set(observed, call.args[0]); },
                after(_ctx, call) { call.replaceResult(call.result + 1); }
            } }).ready;
        check([f.invoke(5), f.originals, read(d, observed), audit], [17, 1, 8, [8]]);
        sc.dispose();
        check(f.invoke(5), 10);
    });
    test('frida', 'Java skipOriginal bypasses original and returns override', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = javaFixture();
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: { before(_ctx, call) { call.skipOriginal(101); } } }).ready;
        check([f.invoke(2), f.originals], [101, 0]);
        sc.dispose();
    });
    test('frida', 'Java validation fails before perform, not on intercepted invocation', () => {
        const { d } = fixture();
        const s = d.scope(), f = javaFixture();
        A.throws(() => attachJavaHook(d, s, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: null }), TypeError);
    });
    test('frida', 'Java second managed hook rejected and released on disposal', async () => {
        const { d } = fixture();
        const a = d.scope(), b = d.scope(), f = javaFixture();
        await attachJavaHook(d, a, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: { before(_ctx, call) { call.replaceArg(0, 10); } } }).ready;
        await A.rejects(attachJavaHook(d, b, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: {} }).ready, /already has a Nexus hook/);
        check(f.invoke(1), 20);
        a.dispose();
        await attachJavaHook(d, b, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: {} }).ready;
        check(f.invoke(1), 2);
        b.dispose();
    });
    test('frida', 'Java propagate on nested uncommitted transaction fails closed', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = javaFixture();
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], failure: 'propagate', callbacks: { before(_ctx, call) { call.skipOriginal(77); } } }).ready;
        d.inline(() => A.throws(() => f.invoke(5), ManagedHookFailure));
        check(f.originals, 0);
        sc.dispose();
    });
    test('frida', 'Java passthrough on nested uncommitted transaction calls original once', async () => {
        const { d, errors } = fixture();
        const sc = d.scope(), f = javaFixture();
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: { before(_ctx, call) { call.skipOriginal(77); } } }).ready;
        d.inline(() => check(f.invoke(5), 10));
        check([f.originals, errors.length], [1, 1]);
        sc.dispose();
    });
    test('frida', 'IL2CPP before/after override and original lifecycle', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = ilFixture();
        await attachIl2CppHook(d, sc, f.bridge, { assembly: 'A', className: 'P', methodName: 'calc', callbacks: { before(_ctx, call) { call.replaceArg(0, 4); }, after(_ctx, call) { call.replaceResult(call.result + 2); } } }).ready;
        check([f.method.implementation.call({}, 5), f.originals], [14, 1]);
        sc.dispose();
        check(f.method.implementation, null);
    });
    test('frida', 'IL2CPP skipOriginal and no original execution', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = ilFixture();
        await attachIl2CppHook(d, sc, f.bridge, { assembly: 'A', className: 'P', methodName: 'calc', callbacks: { before(_ctx, call) { call.skipOriginal(120); } } }).ready;
        check([f.method.implementation.call({}, 5), f.originals], [120, 0]);
        sc.dispose();
    });
    test('frida', 'Native onEnter-onLeave tracks per-invocation state; dispose stops hook', () => {
        const { d } = fixture();
        const sc = d.scope(), f = nativeFixture(), logs = [];
        attachHook(d, sc, f.runtime, 0x1000, { onEnter(ctx, args, state, inv) { state.before = args[0]; ctx.effect(() => logs.push('enter' + inv.threadId)); }, onLeave(ctx, ret, state) { ret.replace(ret.value + state.before); ctx.effect(() => logs.push('leave')); } });
        const a = f.enter(1, [3]), b = f.enter(2, [7]);
        check([f.leave(b, -5), f.leave(a, -5)], [2, -2]);
        sc.dispose();
        check(f.detached, true);
        check(logs, ['enter1', 'enter2', 'leave', 'leave']);
    });
    test('frida', 'native postcommit reaction failure preserves invocation state through onLeave', () => {
        const { d, errors } = fixture();
        const sc = d.scope(), f = nativeFixture(), trigger = d.store(0), log = [];
        d.register(handler(() => { throw Error('reaction'); }), { on: { any: [trigger] }, execution: 'inline' });
        attachHook(d, sc, f.runtime, 0x1000, { onEnter(ctx, args, state) { state.delta = args[0]; ctx.set(trigger, 1); }, onLeave(_ctx, ret, state) { ret.replace(ret.value + state.delta); log.push(state.delta); } });
        const inv = f.enter(1, [4]);
        check(f.leave(inv, 10), 14);
        check(log, [4]);
        check(errors.length, 1);
        sc.dispose();
    });
};
