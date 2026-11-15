'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 61-80: Cross-adapter production-like workflows, scheduling, and fault injection.
    test('full-stack', 'Java damage hook → inline Event → Handler → IL2CPP alive hook', async () => {
        const { d } = fixture();
        const java = javaFixture(), il = ilFixture(), sc = d.scope();
        const damage = sc.event(), hp = sc.store(100), death = sc.store(false);
        sc.register(handler(ctx => { const amount = ctx.event(damage)?.value; if (amount === undefined)
            return; const next = Math.max(0, ctx.read(hp) - amount); ctx.set(hp, next); if (next === 0)
            ctx.set(death, true); }), { on: { any: [damage] }, execution: 'inline', delivery: 'each' });
        await attachJavaHook(d, sc, java.bridge, { className: 'Player', methodName: 'calc', overload: [], callbacks: { before(ctx, call) { ctx.emit(damage, call.args[0]); } } }).ready;
        await attachIl2CppHook(d, sc, il.bridge, { assembly: 'Assembly-CSharp', className: 'Player', methodName: 'calc', callbacks: { before(ctx, call) { if (ctx.read(death))
                    call.skipOriginal(0); } } }).ready;
        check(java.invoke(25), 50);
        check([read(d, hp), il.method.implementation.call({}, 4)], [75, 12]);
        check(java.invoke(90), 180);
        check([read(d, hp), read(d, death), il.method.implementation.call({}, 4)], [0, true, 0]);
        sc.dispose();
    });
    test('full-stack', 'Native hook publishes Event, processing changes native retval synchronously', () => {
        const { d } = fixture();
        const sc = d.scope(), fr = nativeFixture(), event = sc.event(), flag = sc.store(false);
        sc.register(handler(ctx => { const n = ctx.event(event)?.value; if (n !== undefined && n === 7)
            ctx.set(flag, true); }), { on: { any: [event] }, execution: 'inline' });
        attachHook(d, sc, fr.runtime, 0x1000, {
            onEnter(ctx, args, state) { state.x = args[0]; ctx.emit(event, args[0]); },
            onLeave(ctx, retval, state) { if (ctx.read(flag) && state.x === 7)
                ctx.effect(() => retval.replace(0), { owner: sc }); }
        });
        const a = fr.enter(1, [3]);
        check(fr.leave(a, -11), -11);
        const b = fr.enter(2, [7]);
        check(fr.leave(b, -11), 0);
        sc.dispose();
    });
    test('full-stack', 'Reentrant nested native onLeave from postcommit effect modifies borrowed retval in time', () => {
        const { d } = fixture({ maxInlineDepth: 16, maxInlineWaves: 50 });
        const sc = d.scope(), fr = nativeFixture(), start = sc.event(), compare = sc.event({ storage: 'reference' }), log = [];
        sc.register(handler(ctx => { const v = ctx.event(compare)?.value; if (v !== undefined)
            ctx.effect(() => v.ret.replace(0), { owner: sc }); }), { on: { any: [compare] }, execution: 'inline', delivery: 'each' });
        attachHook(d, sc, fr.runtime, 0x1000, { onLeave(ctx, ret) { ctx.emit(compare, { ret }); } });
        sc.register(handler(ctx => {
            if (ctx.event(start))
                ctx.effect(() => { const invocation = fr.enter(1); log.push(fr.leave(invocation, -13)); }, { owner: sc });
        }), { on: { any: [start] }, execution: 'inline' });
        d.inline(ctx => ctx.emit(start, 1));
        check(log, [0]);
        sc.dispose();
    });
    test('full-stack', 'Cross-runtime scopes: unloading Java does not unregister IL2CPP', async () => {
        const { d } = fixture(), java = javaFixture(), il = ilFixture(), j = d.scope(), u = d.scope();
        await attachJavaHook(d, j, java.bridge, { className: 'Player', methodName: 'calc', overload: [], callbacks: { before(_ctx, c) { c.skipOriginal(100); } } }).ready;
        await attachIl2CppHook(d, u, il.bridge, { assembly: 'A', className: 'P', methodName: 'calc', callbacks: { before(_ctx, c) { c.skipOriginal(200); } } }).ready;
        check([java.invoke(3), il.method.implementation.call({}, 3)], [100, 200]);
        j.dispose();
        check([java.invoke(3), il.method.implementation.call({}, 3)], [6, 200]);
        u.dispose();
        check(il.method.implementation, null);
    });
    test('full-stack', 'Java failure after store Commit keeps changed state and diagnoses reaction', async () => {
        const { d, errors } = fixture();
        const sc = d.scope(), java = javaFixture(), source = d.store(0);
        d.register(handler(() => { throw Error('downstream exploded'); }), { on: { any: [source] }, execution: 'inline' });
        await attachJavaHook(d, sc, java.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: { before(ctx) { ctx.set(source, 9); } } }).ready;
        check(java.invoke(2), 4);
        check(read(d, source), 9);
        check(errors.length, 1);
        sc.dispose();
    });
    test('full-stack', 'Native onEnter error suppresses leave without phantom state', () => {
        const { d } = fixture();
        const sc = d.scope(), f = nativeFixture(), seen = [];
        attachHook(d, sc, f.runtime, 0x1000, { onEnter() { throw Error('failed enter'); }, onLeave(_ctx, _ret, st) { seen.push(st); } });
        A.throws(() => f.enter(1, [12]), /failed enter/);
        check(seen, []);
        sc.dispose();
    });
    test('full-stack', 'Managed reference mutation remains external on failed transaction (known hazard)', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = javaFixture(), obj = { hp: 100 };
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], failure: 'propagate', callbacks: { before(_ctx, call) { call.args[0].hp = 1; throw Error('abort'); } } }).ready;
        A.throws(() => f.invoke(obj), ManagedHookFailure);
        check(obj.hp, 1);
        sc.dispose();
    }, 'known-limit');
    test('full-stack', 'Multiple independent Java method invocations retain exact original call count', async () => {
        const { d } = fixture();
        const sc = d.scope(), f = javaFixture(), audit = d.store(0);
        await attachJavaHook(d, sc, f.bridge, { className: 'P', methodName: 'calc', overload: [], callbacks: { before(ctx, call) { if (call.args[0] < 0)
                    call.skipOriginal(0); ctx.update(audit, n => n + 1); } } }).ready;
        const values = [4, -1, 10, 0, -7];
        check(values.map(n => f.invoke(n)), [8, 0, 20, 0, 0]);
        check([f.originals, read(d, audit)], [3, 5]);
        sc.dispose();
    });
    test('scheduler', 'concurrent event commands: each reply id and final accumulator match pure oracle', async () => {
        const { d } = fixture({ maxCommandsBeforeDeferred: 3, maxWavesPerTurn: 5 });
        const evt = d.event(), sum = d.store(0), audit = [];
        d.register(handler(ctx => { const v = ctx.event(evt)?.value; if (v !== undefined) {
            ctx.update(sum, n => n + v);
            ctx.effect(() => audit.push(v));
        } }), { on: { any: [evt] }, execution: 'deferred', delivery: 'each' });
        const inputs = Array.from({ length: 70 }, (_, i) => i + 1);
        const promises = inputs.map(n => d.submitAndWait(ctx => { ctx.emit(evt, n); return n * 2; }));
        const responses = await timeout(Promise.all(promises), 8000);
        check(responses, inputs.map(n => n * 2));
        check(read(d, sum), 2485);
        check(audit.length, 70);
        check(audit.slice().sort((a, b) => a - b), inputs);
    });
    test('scheduler', 'command and deferred Handler ordering is fair enough to complete backlog', async () => {
        const { d } = fixture({ maxCommandsBeforeDeferred: 2, maxWavesPerTurn: 2 });
        const evt = d.event(), s = d.store(0), log = [];
        d.register(handler(ctx => { const n = ctx.event(evt)?.value; if (n !== undefined) {
            ctx.update(s, v => v + n);
            log.push('handler');
        } }), { on: { any: [evt] }, execution: 'deferred', delivery: 'each' });
        const pending = Array.from({ length: 50 }, (_, i) => d.submit(ctx => { ctx.emit(evt, i + 1); log.push('command'); }));
        await timeout(Promise.all(pending));
        d.flush();
        check(read(d, s), 1275);
        check(log.filter(n => n === 'handler').length, 50);
        A.ok(log.indexOf('handler') >= 0 && log.indexOf('handler') < 25, 'deferred handler should not starve');
    });
    test('scheduler', 'subscription lifecycle: unsubscribe while pending jobs removes all callbacks', () => {
        const { d } = fixture();
        const e = d.event(), result = [];
        const reg = d.register(handler(ctx => result.push(ctx.event(e).value)), { on: { any: [e] }, delivery: 'each', execution: 'deferred' });
        d.inline(ctx => [1, 2, 3].forEach(n => ctx.emit(e, n)));
        reg.dispose();
        d.flush();
        check(result, []);
    });
    test('scheduler', 'postcommit effect can explicitly request Handler after durable source change', () => {
        const { d } = fixture();
        const base = d.store(2), derived = d.store(0), trace = [];
        const reg = d.register(handler(ctx => { ctx.set(derived, ctx.read(base) * 10); trace.push('requested'); }), { execution: 'inline' });
        d.inline(ctx => { ctx.set(base, 5); ctx.effect(() => { trace.push('effect'); d.request(reg); }); });
        check([read(d, derived), trace], [50, ['effect', 'requested']]);
    });
    test('scheduler', 'no hidden subscription from ctx.read in Handler', () => {
        const { d } = fixture();
        const a = d.store(0), b = d.store(0), count = d.store(0);
        d.register(handler(ctx => { ctx.read(b); ctx.update(count, x => x + 1); }), { on: { any: [a] }, execution: 'inline' });
        d.inline(ctx => ctx.set(b, 10));
        check(read(d, count), 0);
        d.inline(ctx => ctx.set(a, 1));
        check(read(d, count), 1);
    });
    test('scheduler', 'Scope dependency prevents early owner disposal; retries after borrower close', () => {
        const { d } = fixture();
        const owner = d.scope(), borrower = d.scope();
        const store = owner.store(123);
        borrower.dependsOn(owner);
        A.throws(() => owner.dispose(), /dependent Scope/);
        check(read(d, store), 123);
        borrower.dispose();
        owner.dispose();
        A.throws(() => read(d, store), /not registered/);
    });
    test('scheduler', 'on.all joins after two distinct Store commits, no correlation by instance', () => {
        const { d } = fixture();
        const a = d.store(0), b = d.store(0), counter = d.store(0);
        d.register(handler(ctx => ctx.update(counter, n => n + 1)), { on: { all: [a, b] }, execution: 'inline' });
        d.inline(ctx => ctx.set(a, 1));
        d.inline(ctx => ctx.set(a, 2));
        check(read(d, counter), 0);
        d.inline(ctx => ctx.set(b, 1));
        check(read(d, counter), 1);
        d.inline(ctx => ctx.set(b, 2));
        check(read(d, counter), 1);
        d.inline(ctx => ctx.set(a, 3));
        check(read(d, counter), 2);
    });
    test('safety', 'try to submit() inside uncommitted Handler: fails without late work', () => {
        const { d } = fixture();
        const event = d.store(0), other = d.store(0);
        d.register(handler(() => { void d.submit(ctx => ctx.set(other, 9)); }), { on: { any: [event] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(event, 1)), PostCommitReactionError);
        check(read(d, other), 0);
    });
    test('safety', 'manual request of disposed Handler is rejected', () => {
        const { d } = fixture();
        const r = d.register(handler(() => { }), { execution: 'inline' });
        r.dispose();
        A.throws(() => d.request(r), /Unregistered handler/);
    });
};
