'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 78-82: Additional safety boundaries and lifecycle failure injection.
    test('safety', 'owned async effect that passed preflight still runs after Scope disposal', async () => {
        const { d } = fixture();
        const sc = d.scope(), out = [];
        let resume;
        const barrier = new Promise(r => resume = r);
        d.inline(ctx => ctx.effect(async () => { await barrier; out.push('used-expired-resource'); }, { owner: sc }));
        sc.dispose();
        resume();
        await Promise.resolve();
        await Promise.resolve();
        check(out, ['used-expired-resource']);
    }, 'known-limit');
    test('safety', 'deferred event cannot safely retain a borrowed native retval', () => {
        const { d, errors } = fixture();
        const sc = d.scope(), evt = sc.event({ storage: 'reference' });
        sc.register(handler(ctx => ctx.event(evt).value.ret.replace(0)), { on: { any: [evt] }, delivery: 'each', execution: 'deferred' });
        const nativeRet = { alive: true, value: -13, replace(n) { if (!this.alive)
                throw Error('retval expired'); this.value = n; } };
        d.inline(ctx => ctx.emit(evt, { ret: nativeRet }));
        nativeRet.alive = false;
        A.throws(() => d.flush(), /retval expired/);
        check(nativeRet.value, -13);
        sc.dispose();
    }, 'known-limit');
    test('lifecycle', 'registration initial inline executes synchronously and can be disposed', () => {
        const { d } = fixture();
        const s = d.store(13), out = [];
        const r = d.register(handler(ctx => out.push(ctx.read(s))), { execution: 'inline', initial: true });
        check(out, [13]);
        r.dispose();
        check(r.active, false);
    });
    test('lifecycle', 'Scope cleanup error can be retried without redoing completed LIFO tasks', () => {
        const { d } = fixture();
        const sc = d.scope(), log = [];
        let fail = true;
        sc.cleanup(() => log.push('older'));
        sc.cleanup(() => { log.push('retry'); if (fail) {
            fail = false;
            throw Error('temporary');
        } });
        sc.cleanup(() => log.push('newer'));
        A.throws(() => sc.dispose(), AggregateError);
        check(log, ['newer', 'retry']);
        sc.dispose();
        check(log, ['newer', 'retry', 'retry', 'older']);
    });
    test('lifecycle', 'Scope.guard synchronous callback no-ops after dispose', () => {
        const { d } = fixture();
        const sc = d.scope(), seen = [];
        const g = sc.guard(n => seen.push(n));
        g(1);
        sc.dispose();
        g(2);
        check(seen, [1]);
    });
};
