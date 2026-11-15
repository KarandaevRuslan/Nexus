'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 54-60: Stress, reproducibility, and targeted desired safety guarantees.
    test('stress', '600 event batches vs independent histogram oracle', async () => {
        const { d } = fixture({ maxWavesPerTurn: 12 });
        const e = d.event(), s = d.store({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }), received = d.store(0);
        d.register(handler(ctx => { const n = ctx.event(e)?.value; if (n === undefined)
            return; const h = ctx.read(s); ctx.set(s, { ...h, [n]: h[n] + 1 }); ctx.update(received, x => x + 1); }), { on: { any: [e] }, execution: 'deferred', delivery: 'each', buffer: { capacity: 1024 } });
        const oracle = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        let seed = 0x1984;
        for (let batch = 0; batch < 30; batch++) {
            const nums = [];
            for (let j = 0; j < 20; j++) {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                const n = seed % 5;
                nums.push(n);
                oracle[n]++;
            }
            await timeout(d.submitAndWait(ctx => nums.forEach(n => ctx.emit(e, n))), 4000);
        }
        check([read(d, s), read(d, received)], [oracle, 600]);
    });
    test('stress', '300 chained deferred workflow steps with bounded scheduler', async () => {
        const { d } = fixture({ maxCausalWaves: 500, maxWavesPerTurn: 5 });
        const counter = d.store(0);
        d.register(handler(ctx => { const v = ctx.read(counter); if (v < 300)
            ctx.set(counter, v + 1); }), { on: { any: [counter] }, execution: 'deferred' });
        await timeout(d.submitAndWait(ctx => ctx.set(counter, 1)), 5000);
        check(read(d, counter), 300);
    });
    test('stress', '40 concurrent causal waiters with coalesced latest event', async () => {
        const { d } = fixture({ maxCausalWaves: 500 });
        const e = d.event(), seen = [], status = d.store(0);
        d.register(handler(ctx => { const val = ctx.event(e)?.value; if (val !== undefined) {
            ctx.set(status, val);
            seen.push(val);
        } }), { on: { any: [e] }, execution: 'deferred', delivery: 'latest' });
        const promises = Array.from({ length: 40 }, (_, i) => d.submitAndWait(ctx => ctx.emit(e, i + 1)));
        await timeout(Promise.all(promises), 8000);
        check(read(d, status), 40);
        A.ok(seen.length >= 1 && seen.at(-1) === 40);
    });
    test('stress', 'Scope churn: 100 create → emit → dispose cycles', async () => {
        const { d } = fixture();
        const external = d.store(0);
        for (let i = 0; i < 100; i++) {
            const s = d.scope(), evt = s.event();
            s.register(handler(ctx => { const v = ctx.event(evt)?.value; if (v !== undefined)
                ctx.update(external, n => n + v); }), { on: { any: [evt] }, execution: 'deferred', delivery: 'each' });
            await timeout(d.submitAndWait(ctx => ctx.emit(evt, 1)));
            s.dispose();
            A.ok(!s.active);
        }
        check(read(d, external), 100);
    });
    // Deliberately assert stronger, *desired* safety contract. If it fails, report as confirmed defect.
    test('safety', 'on.all+each is rejected at registration as explicitly unsupported', () => {
        const { d } = fixture();
        const a = d.store(0), b = d.store(0);
        A.throws(() => d.register(handler(() => { }), { on: { all: [a, b] }, execution: 'deferred', delivery: 'each', buffer: { capacity: 1, overflow: 'reject' } }), /delivery:'each' with on.all is ambiguous/);
    }, 'known-limit');
    test('safety', 'effect-only async callback must not be treated as causally awaited', async () => {
        const { d } = fixture();
        const s = d.store(0);
        let unblock;
        const barrier = new Promise(resolve => unblock = resolve);
        await timeout(d.submitAndWait(ctx => ctx.effect(async () => { await barrier; d.inline(x => x.set(s, 42)); })));
        check(read(d, s), 0);
        unblock();
        await Promise.resolve();
        await Promise.resolve();
        check(read(d, s), 42);
    }, 'known-limit');
};
