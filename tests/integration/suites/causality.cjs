'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 34-43: Cause tracking, errors, time and lifecycle.
    test('causality', 'submit resolves before deferred propagation, submitAndWait does not', async () => {
        const { d } = fixture();
        const s = d.store(0), result = d.store(0);
        d.register(handler(ctx => ctx.set(result, ctx.read(s) * 10)), { on: { any: [s] }, execution: 'deferred' });
        await timeout(d.submit(ctx => ctx.set(s, 8)));
        const shortly = read(d, result); // scheduler may or may not have processed it, but after manual flush guaranteed
        d.flush();
        check(read(d, result), 80);
        A.ok([0, 80].includes(shortly));
        await timeout(d.submitAndWait(ctx => ctx.set(s, 9)));
        check(read(d, result), 90);
    });
    test('causality', 'submitAndWait descendants including ctx.request', async () => {
        const { d } = fixture();
        const source = d.event(), state = d.store(0), terminal = d.store(0);
        const fin = d.register(handler(ctx => ctx.set(terminal, ctx.read(state) + 1)), { execution: 'deferred' });
        d.register(handler(ctx => { const value = ctx.event(source)?.value; if (value != null) {
            ctx.set(state, value * 5);
            ctx.request(fin);
        } }), { on: { any: [source] }, delivery: 'each', execution: 'deferred' });
        await timeout(d.submitAndWait(ctx => ctx.emit(source, 7)));
        check([read(d, state), read(d, terminal)], [35, 36]);
    });
    test('causality', 'postcommit effect submits descendant command, waiter tracks it', async () => {
        const { d } = fixture();
        const count = d.store(0);
        await timeout(d.submitAndWait(ctx => ctx.effect(() => { void d.submit(c => c.set(count, 17)); })));
        check(read(d, count), 17);
    });
    test('causality', 'failed descendant rejects await but preserves parent commit', async () => {
        const { d } = fixture();
        const s = d.store(0), report = [];
        d.register(handler(() => { report.push('failed'); throw Error('descendant'); }), { on: { any: [s] }, execution: 'deferred' });
        await A.rejects(timeout(d.submitAndWait(ctx => ctx.set(s, 1))), /descendant/);
        check([read(d, s), report], [1, ['failed']]);
    });
    test('causality', 'onError throwing does not undo effect/commit or block later effects', () => {
        const d = new Dispatcher({ onError() { throw Error('reporter error'); } });
        const s = d.store(0), trace = [];
        d.inline(ctx => { ctx.set(s, 7); ctx.effect(() => { throw Error('effect failed'); }); ctx.effect(() => trace.push('next')); });
        check([read(d, s), trace], [7, ['next']]);
    });
    test('causality', 'inline recursion limit rejects before JS stack overflow', () => {
        const { d, errors } = fixture({ maxInlineDepth: 7, maxCausalWaves: 5000, maxInlineWaves: 5000 });
        const count = d.store(0);
        const visit = () => d.inline(ctx => { ctx.update(count, n => n + 1); ctx.effect(visit); });
        visit();
        check(read(d, count), 7);
        A.ok(errors.some(e => e.includes('Nested inline transaction depth')));
    });
    test('causality', 'Scope dispose cancels queued submit() before start', async () => {
        const { d } = fixture();
        const scope = d.scope(), foreign = d.store(0);
        const pending = scope.submit(ctx => ctx.set(foreign, 10));
        scope.dispose();
        await A.rejects(timeout(pending), /Scope disposed/);
        check(read(d, foreign), 0);
    });
    test('causality', 'Scope child resources dispose before parent cleanup', () => {
        const { d } = fixture();
        const p = d.scope(), c = p.child(), calls = [];
        p.cleanup(() => calls.push('parent'));
        c.cleanup(() => calls.push('child'));
        p.dispose();
        check(calls, ['child', 'parent']);
    });
    test('causality', 'effect owner prevents running after another effect closes Scope', () => {
        const { d } = fixture();
        const s = d.scope(), log = [];
        d.inline(ctx => { ctx.effect(() => s.dispose()); ctx.effect(() => log.push('unsafe'), { owner: s }); });
        check(log, []);
    });
    test('causality', 'effect origin Registration prevents use after disposal', () => {
        const { d } = fixture();
        const source = d.store(0), log = [];
        let b;
        const a = d.register(handler(ctx => ctx.effect(() => b.dispose())), { on: { any: [source] }, execution: 'inline' });
        b = d.register(handler(ctx => ctx.effect(() => log.push('B_effect'))), { on: { any: [source] }, execution: 'inline' });
        d.inline(ctx => ctx.set(source, 1));
        check([b.active, log], [false, []]);
    });
    test('causality', 'async scope.guard is entry-only, documented limitation', async () => {
        const { d } = fixture();
        const sc = d.scope(), other = d.store(0);
        let go;
        const barrier = new Promise(resolve => go = resolve);
        const fn = sc.guard(async () => { await barrier; d.inline(ctx => ctx.set(other, 42)); });
        fn();
        sc.dispose();
        go();
        await Promise.resolve();
        await Promise.resolve();
        check(read(d, other), 42); // Explicitly assert current (unsafe) semantics, NOT a success on safety.
    }, 'known-limit');
};
