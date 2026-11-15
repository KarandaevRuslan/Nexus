'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 12-24: Event stream and transaction contracts.
    test('events', 'three emissions in one transaction preserve each occurrence', () => {
        const { d } = fixture();
        const evt = d.event(), received = [];
        d.register(handler(ctx => received.push(ctx.event(evt).value)), { on: { any: [evt] }, delivery: 'each', execution: 'deferred' });
        d.inline(ctx => [3, 4, 5].forEach(v => ctx.emit(evt, v)));
        d.flush();
        check(received, [3, 4, 5]);
    });
    test('events', 'latest event coalesces to newest payload', () => {
        const { d } = fixture();
        const evt = d.event(), received = [];
        d.register(handler(ctx => received.push(ctx.event(evt)?.value)), { on: { any: [evt] }, delivery: 'latest' });
        [1, 2, 3, 4].forEach(n => d.inline(ctx => ctx.emit(evt, n)));
        d.flush();
        check(received, [4]);
    });
    test('events', 'event-only transaction increments revision', () => {
        const { d } = fixture();
        const e = d.event();
        const rev = d.currentRevision;
        d.inline(ctx => ctx.emit(e, 77));
        check(d.currentRevision, rev + 1);
    });
    test('events', 'request-only transaction invokes Handler exactly twice', () => {
        const { d } = fixture();
        const s = d.store(0);
        const r = d.register(handler(ctx => ctx.update(s, n => n + 1)), { execution: 'inline', delivery: 'each' });
        d.inline(ctx => { ctx.request(r); ctx.request(r); });
        check(read(d, s), 2);
    });
    test('events', 'failed parent Handler cannot emit or request child', () => {
        const { d } = fixture();
        const source = d.store(0), count = d.store(0), e = d.event(), seen = [];
        const b = d.register(handler(ctx => ctx.update(count, n => n + 100)), { execution: 'inline' });
        d.register(handler(ctx => seen.push(ctx.event(e)?.value)), { on: { any: [e] }, execution: 'inline' });
        d.register(handler(ctx => { ctx.request(b); ctx.emit(e, 8); throw Error('abort'); }), { on: { any: [source] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
        check([read(d, count), seen], [0, []]);
    });
    test('events', 'failed outer inline cancels staged write event and request', () => {
        const { d } = fixture();
        const s = d.store(0), e = d.event(), called = [];
        const reg = d.register(handler(() => called.push('req')), { execution: 'inline' });
        d.register(handler(ctx => called.push(ctx.event(e).value)), { on: { any: [e] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => { ctx.set(s, 8); ctx.emit(e, 7); ctx.request(reg); throw Error('halt'); }), /halt/);
        check([read(d, s), called], [0, []]);
    });
    test('events', 'mixed Store+Event Handler sees each kind and one event', () => {
        const { d } = fixture();
        const state = d.store(0), event = d.event(), seen = [];
        d.register(handler(ctx => seen.push({ v: ctx.read(state), ev: ctx.event(event)?.value ?? null })), { on: { any: [state, event] }, execution: 'deferred', delivery: 'each' });
        d.inline(ctx => { ctx.set(state, 1); ctx.emit(event, 'x'); });
        d.flush();
        check(seen, [{ v: 1, ev: null }, { v: 1, ev: 'x' }]);
    });
    test('events', 'event used in on.all rejected before live registration', () => {
        const { d } = fixture();
        const e = d.event();
        A.throws(() => d.register(handler(() => { }), { on: { all: [e] } }), /on.all only supports Stores/);
    });
    test('events', 'event buffer reject rolls back Store and event', () => {
        const { d } = fixture();
        const e = d.event(), s = d.store(0), seen = [];
        d.register(handler(ctx => seen.push(ctx.event(e).value)), { on: { any: [e] }, delivery: 'each', buffer: { capacity: 2, overflow: 'reject' } });
        A.throws(() => d.inline(ctx => { ctx.set(s, 9); ctx.emit(e, 1); ctx.emit(e, 2); ctx.emit(e, 3); }), BufferOverflowError);
        check(read(d, s), 0);
        d.flush();
        check(seen, []);
    });
    test('events', 'drop-oldest retains last 2', () => {
        const { d } = fixture();
        const e = d.event(), seen = [];
        d.register(handler(ctx => seen.push(ctx.event(e).value)), { on: { any: [e] }, delivery: 'each', buffer: { capacity: 2, overflow: 'drop-oldest' } });
        d.inline(ctx => [1, 2, 3, 4].forEach(n => ctx.emit(e, n)));
        d.flush();
        check(seen, [3, 4]);
    });
    test('events', 'drop-newest retains first 2', () => {
        const { d } = fixture();
        const e = d.event(), seen = [];
        d.register(handler(ctx => seen.push(ctx.event(e).value)), { on: { any: [e] }, delivery: 'each', buffer: { capacity: 2, overflow: 'drop-newest' } });
        d.inline(ctx => [1, 2, 3, 4].forEach(n => ctx.emit(e, n)));
        d.flush();
        check(seen, [1, 2]);
    });
    test('events', 'store changed versus record:always touched', () => {
        const { d } = fixture();
        const s = d.store(5), kinds = [];
        d.register(handler(ctx => kinds.push(ctx.change(s)?.kind)), { on: { any: [s] }, execution: 'inline', delivery: 'each' });
        d.inline(ctx => ctx.set(s, 5));
        d.inline(ctx => ctx.set(s, 5, { record: 'always' }));
        d.inline(ctx => ctx.set(s, 7));
        check(kinds, ['touched', 'changed']);
    });
    test('events', 'ctx.before/after report triggering revision while read sees current', () => {
        const { d } = fixture();
        const s = d.store(0), observed = [];
        d.register(handler(ctx => observed.push({ before: ctx.before.read(s), after: ctx.after.read(s), now: ctx.read(s) })), { on: { any: [s] }, delivery: 'each', execution: 'deferred' });
        d.inline(ctx => ctx.set(s, 3));
        d.inline(ctx => ctx.set(s, 6));
        d.inline(ctx => ctx.set(s, 9));
        d.flush();
        check(observed, [{ before: 0, after: 3, now: 9 }, { before: 3, after: 6, now: 9 }, { before: 6, after: 9, now: 9 }]);
    });
};
