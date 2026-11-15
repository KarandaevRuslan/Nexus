'use strict';
/** Integration scenarios, registered in their historical execution order. */
module.exports = function register(kit) {
    const { A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler, timeout, javaFixture, ilFixture, nativeFixture, } = kit;
    // 25-33: Conflict and wave safety.
    test('conflict', 'reject aborts all speculative peer writes, including independent', () => {
        const { d } = fixture();
        const trigger = d.store(0), shared = d.store(0), audit = d.store(0);
        d.register(handler(ctx => ctx.set(shared, 1)), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => ctx.set(shared, 2)), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => ctx.set(audit, 99)), { on: { any: [trigger] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(trigger, 1)), PostCommitReactionError);
        check([read(d, trigger), read(d, shared), read(d, audit)], [1, 0, 0]);
    });
    test('conflict', 'skip conflict drops entire wave', () => {
        const { d } = fixture({ conflictFallback: 'skip' });
        const trigger = d.store(0), shared = d.store(0), third = d.store(0);
        d.register(handler(ctx => ctx.set(shared, 1)), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => ctx.set(shared, 2)), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => ctx.set(third, 7)), { on: { any: [trigger] }, execution: 'inline' });
        d.inline(ctx => ctx.set(trigger, 1));
        check([read(d, shared), read(d, third)], [0, 0]);
    });
    test('conflict', 'sequence replay makes later read earlier speculative result', () => {
        const { d } = fixture();
        const trigger = d.store(0), shared = d.store(0), trace = [];
        const a = d.register(handler(ctx => { trace.push(`A:${ctx.read(shared)}`); ctx.set(shared, 10); }), { on: { any: [trigger] }, execution: 'inline' });
        const b = d.register(handler(ctx => { trace.push(`B:${ctx.read(shared)}`); ctx.set(shared, ctx.read(shared) + 5); }), { on: { any: [trigger] }, execution: 'inline' });
        d.conflicts.add({ store: shared, between: [a, b], resolve: { strategy: 'sequence', order: [a, b] } });
        d.inline(ctx => ctx.set(trigger, 1));
        check(read(d, shared), 15);
        check(trace.slice(-2), ['A:0', 'B:10']);
    });
    test('conflict', 'sequence replay must publish only one downstream wake', () => {
        const { d } = fixture();
        const trigger = d.store(0), shared = d.store(0), out = [];
        const a = d.register(handler(ctx => ctx.set(shared, 11)), { on: { any: [trigger] }, execution: 'inline' });
        const b = d.register(handler(ctx => ctx.set(shared, 22)), { on: { any: [trigger] }, execution: 'inline' });
        d.conflicts.add({ store: shared, between: [a, b], resolve: { strategy: 'sequence', order: [a, b] } });
        d.register(handler(ctx => out.push(ctx.read(shared))), { on: { any: [shared] }, execution: 'inline' });
        d.inline(ctx => ctx.set(trigger, 1));
        check(out, [22]);
    });
    test('conflict', 'failed guard restores independent sibling work', () => {
        const { d } = fixture();
        const trigger = d.store(0), saved = d.store(0), visited = [];
        d.register(handler(() => { visited.push('bad'); throw Error('fail'); }), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => { visited.push('good'); ctx.set(saved, 77); }), { on: { any: [trigger] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(trigger, 1)), PostCommitReactionError);
        check([read(d, saved), visited], [77, ['bad', 'good']]);
    });
    test('conflict', 'failed commit with emitted event cannot publish it', () => {
        const { d } = fixture();
        const trigger = d.store(0), shared = d.store(0), e = d.event(), out = [];
        d.register(handler(ctx => { ctx.set(shared, 1); ctx.emit(e, 'A'); }), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => { ctx.set(shared, 2); ctx.emit(e, 'B'); }), { on: { any: [trigger] }, execution: 'inline' });
        d.register(handler(ctx => out.push(ctx.event(e).value)), { on: { any: [e] }, execution: 'inline', delivery: 'each' });
        A.throws(() => d.inline(ctx => ctx.set(trigger, 1)), PostCommitReactionError);
        check(out, []);
    });
    test('conflict', 'registration operations during run are rejected before teardown', () => {
        const { d } = fixture();
        const trigger = d.store(0), sum = d.store(0);
        const b = d.register(handler(ctx => ctx.set(sum, 9)), { execution: 'inline' });
        d.register(handler(() => b.dispose()), { on: { any: [trigger] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(trigger, 1)), PostCommitReactionError);
        check(b.active, true);
    });
    test('conflict', 'handler effect only runs after successful commit', () => {
        const { d } = fixture();
        const source = d.store(0), sink = d.store(0), out = [];
        d.register(handler(ctx => { ctx.set(sink, 1); ctx.effect(() => out.push('shouldNotRun')); throw Error('abort'); }), { on: { any: [source] }, execution: 'inline' });
        A.throws(() => d.inline(ctx => ctx.set(source, 1)), PostCommitReactionError);
        check([read(d, sink), out], [0, []]);
    });
    test('conflict', 'immutable Store does not expose mutable nested payload', () => {
        const { d } = fixture();
        const s = d.store({ inventory: { coins: 3 }, items: [1, 2] });
        const value = read(d, s);
        A.throws(() => { value.inventory.coins = 999; }, TypeError);
        A.throws(() => { value.items.push(3); }, TypeError);
        check(read(d, s), { inventory: { coins: 3 }, items: [1, 2] });
    });
};
