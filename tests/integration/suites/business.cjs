'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 01-11: Business workflows and independent reference models.
    test('business', 'inventory → pricing → billing → receipt across deferred graph', async () => {
        const { d } = fixture();
        const order = d.event();
        const stock = d.store({ A: 8, B: 3 });
        const wallet = d.store(1000);
        const price = d.store({ A: 20, B: 70 });
        const bill = d.store(null);
        const receipts = [];
        const audit = [];
        const post = d.register(handler(ctx => { const b = ctx.read(bill); if (b) {
            ctx.effect(() => receipts.push({ id: b.id, total: b.total }), { lifetime: 'independent' });
        } }), { execution: 'deferred' });
        d.register(handler(ctx => { const b = ctx.read(bill); if (b)
            ctx.effect(() => audit.push(b.id)); }), { on: { any: [bill] }, execution: 'deferred' });
        d.register(handler(ctx => {
            const o = ctx.event(order)?.value;
            if (!o)
                return;
            const inventory = ctx.read(stock), balance = ctx.read(wallet), total = ctx.read(price)[o.sku] * o.qty;
            if (inventory[o.sku] < o.qty || balance < total) {
                ctx.set(bill, { id: o.id, rejected: true, total: 0 });
            }
            else {
                ctx.set(stock, { ...inventory, [o.sku]: inventory[o.sku] - o.qty });
                ctx.set(wallet, balance - total);
                ctx.set(bill, { id: o.id, rejected: false, total });
            }
            ctx.request(post);
        }), { on: { any: [order] }, execution: 'deferred', delivery: 'each' });
        for (const o of [{ id: 'p1', sku: 'A', qty: 2 }, { id: 'p2', sku: 'B', qty: 1 }, { id: 'p3', sku: 'B', qty: 9 }])
            await timeout(d.submitAndWait(ctx => ctx.emit(order, o)));
        check(read(d, stock), { A: 6, B: 2 });
        check(read(d, wallet), 890);
        check(receipts, [{ id: 'p1', total: 40 }, { id: 'p2', total: 70 }, { id: 'p3', total: 0 }]);
        check(audit, ['p1', 'p2', 'p3']);
    });
    test('business', 'banking: 240 sequential transfers vs pure ledger model', async () => {
        const { d } = fixture();
        const evt = d.event();
        const balances = d.store({ a: 3000, b: 2200, c: 5000 });
        const notices = d.store(0);
        d.register(handler(ctx => { const t = ctx.event(evt)?.value; if (!t)
            return; const b = ctx.read(balances); if (b[t.from] < t.amount)
            return; ctx.set(balances, { ...b, [t.from]: b[t.from] - t.amount, [t.to]: b[t.to] + t.amount }); ctx.update(notices, n => n + 1); }), { on: { any: [evt] }, execution: 'deferred', delivery: 'each' });
        const ref = { a: 3000, b: 2200, c: 5000 };
        let count = 0;
        let seed = 123456789;
        const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
        const ids = ['a', 'b', 'c'];
        for (let i = 0; i < 240; i++) {
            const from = ids[rng() % 3], to = ids[(ids.indexOf(from) + 1 + rng() % 2) % 3], amount = 1 + rng() % 150;
            if (ref[from] >= amount) {
                ref[from] -= amount;
                ref[to] += amount;
                count++;
            }
            await timeout(d.submitAndWait(ctx => ctx.emit(evt, { from, to, amount })));
        }
        check(read(d, balances), ref);
        check(read(d, notices), count);
        check(Object.values(ref).reduce((a, b) => a + b, 0), 10200);
    });
    test('business', 'combat damage, death, and owned postcommit announcement', async () => {
        const { d } = fixture();
        const sc = d.scope();
        const hit = sc.event();
        const hp = sc.store(110), dead = sc.store(false);
        const log = [];
        sc.register(handler(ctx => { const dmg = ctx.event(hit)?.value; if (!dmg)
            return; const left = Math.max(0, ctx.read(hp) - dmg); ctx.set(hp, left); if (left === 0 && !ctx.read(dead)) {
            ctx.set(dead, true);
            ctx.effect(() => log.push('dead'), { owner: sc });
        } }), { on: { any: [hit] }, execution: 'deferred', delivery: 'each' });
        for (const damage of [15, 25, 100, 20])
            await timeout(d.submitAndWait(ctx => ctx.emit(hit, damage)));
        check([read(d, hp), read(d, dead), log], [0, true, ['dead']]);
        sc.dispose();
    });
    test('business', 'reusable workflow invocations do not leak event payload or state', async () => {
        const { d } = fixture();
        const e = d.event(), sum = d.store(0), out = [];
        d.register(handler(ctx => { const item = ctx.event(e); if (item) {
            ctx.update(sum, n => n + item.value);
            ctx.effect(() => out.push(item.value));
        } }), { on: { any: [e] }, execution: 'deferred', delivery: 'each' });
        async function add(n) { await d.submitAndWait(ctx => ctx.emit(e, n)); return read(d, sum); }
        check([await add(8), await add(-3), await add(8), await add(0)], [8, 5, 13, 13]);
        check(out, [8, -3, 8, 0]);
    });
    test('business', 'reactive palindrome classifier preserves input/result correspondence', async () => {
        const { d } = fixture();
        const input = d.event(), result = d.store({ word: '', isPalindrome: false });
        const audit = [];
        d.register(handler(ctx => { const w = ctx.event(input)?.value; if (w === undefined)
            return; const normalized = w.toLowerCase().replace(/[^a-z]/g, ''); ctx.set(result, { word: w, isPalindrome: normalized === [...normalized].reverse().join('') }); }), { on: { any: [input] }, execution: 'deferred', delivery: 'each' });
        d.register(handler(ctx => { const r = ctx.read(result); ctx.effect(() => audit.push(r)); }), { on: { any: [result] }, execution: 'deferred', delivery: 'each' });
        for (const word of ['Level', 'abc', 'A man a plan a canal Panama', 'aa', 'abca'])
            await d.submitAndWait(ctx => ctx.emit(input, word));
        check(audit.map(x => x.isPalindrome), [true, false, true, true, false]);
    });
    test('business', 'on.all joins independently changing policy flags', () => {
        const { d } = fixture();
        const auth = d.store(false), paid = d.store(false), opens = d.store(0);
        d.register(handler(ctx => { if (ctx.read(auth) && ctx.read(paid))
            ctx.update(opens, n => n + 1); }), { on: { all: [auth, paid] }, execution: 'inline' });
        d.inline(ctx => ctx.set(auth, true));
        check(read(d, opens), 0);
        d.inline(ctx => ctx.set(paid, true));
        check(read(d, opens), 1);
        d.inline(ctx => ctx.set(auth, false));
        check(read(d, opens), 1);
        d.inline(ctx => ctx.set(auth, true));
        check(read(d, opens), 1); // only auth seen since last join
        d.inline(ctx => ctx.set(paid, false));
        check(read(d, opens), 1);
    });
    test('business', 'manual request re-evaluates when without trigger Store write', () => {
        const { d } = fixture();
        const enabled = d.store(false), score = d.store(0);
        const reg = d.register(handler(ctx => ctx.update(score, n => n + 7), ctx => ctx.read(enabled)), { execution: 'inline' });
        d.request(reg);
        check(read(d, score), 0);
        d.inline(ctx => ctx.set(enabled, true));
        d.request(reg);
        d.request(reg);
        check(read(d, score), 14);
    });
    test('business', 'fixed-point propagation A → B → C → D', () => {
        const { d } = fixture({ maxInlineWaves: 150 });
        const stores = Array.from({ length: 4 }, () => d.store(0));
        for (let i = 0; i < 3; i++)
            d.register(handler(ctx => ctx.set(stores[i + 1], ctx.read(stores[i]) * 2 + 1)), { on: { any: [stores[i]] }, execution: 'inline' });
        d.inline(ctx => ctx.set(stores[0], 9));
        check(stores.map(s => read(d, s)), [9, 19, 39, 79]);
    });
    test('business', 'Collatz: 100 starts agree with independent BigInt loop', () => {
        const { d } = fixture({ maxInlineWaves: 2000, maxCausalWaves: 3000 });
        const state = d.store({ n: 1n, steps: 0, head: null });
        d.register(handler(ctx => { const s = ctx.read(state); if (s.n === 1n)
            return; const next = s.n % 2n === 0n ? s.n / 2n : 3n * s.n + 1n; ctx.set(state, { n: next, steps: s.steps + 1, head: { value: next, previous: s.head } }); }), { on: { any: [state] }, execution: 'inline', delivery: 'each' });
        function oracle(start) { let n = BigInt(start), steps = 0; const arr = [n]; while (n !== 1n && steps < 2000) {
            n = n % 2n === 0n ? n / 2n : 3n * n + 1n;
            arr.push(n);
            steps++;
        } return { steps, chain: arr }; }
        for (let start = 1; start <= 100; start++) {
            d.inline(ctx => ctx.set(state, { n: BigInt(start), steps: 0, head: { value: BigInt(start), previous: null } }));
            const final = read(d, state);
            const arr = [];
            for (let h = final.head; h; h = h.previous)
                arr.push(h.value);
            check({ steps: final.steps, chain: arr.reverse() }, oracle(start), `Collatz n=${start}`);
        }
    });
    test('business', 'price recomputation: 120 updates vs independent oracle', () => {
        const { d } = fixture();
        const price = d.store(10), tax = d.store(10), total = d.store(11);
        d.register(handler(ctx => ctx.set(total, Math.trunc(ctx.read(price) * (100 + ctx.read(tax)) / 100))), { on: { any: [price, tax] }, execution: 'inline' });
        for (let i = 1; i <= 120; i++) {
            d.inline(ctx => { ctx.set(price, i * 3); ctx.set(tax, i % 17); });
            check(read(d, total), Math.trunc((i * 3) * (100 + i % 17) / 100));
        }
    });
    test('business', 'event payload snapshot does not follow producer mutation', () => {
        const { d } = fixture();
        const e = d.event(), seen = [];
        d.register(handler(ctx => seen.push(ctx.event(e).value)), { on: { any: [e] }, delivery: 'each', execution: 'deferred' });
        const obj = { id: 5, data: { quantity: 2 } };
        d.inline(ctx => ctx.emit(e, obj));
        obj.id = 100;
        obj.data.quantity = 88;
        d.flush();
        check(seen, [{ id: 5, data: { quantity: 2 } }]);
    });
};
