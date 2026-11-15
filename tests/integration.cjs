'use strict';
// Nexus 0.1.18 black-box adversarial integration suite. Node 18+.
// node integration.cjs /absolute/path/to/nexus-v0.1.18
const path = require('node:path');
const fs = require('node:fs');
const A = require('node:assert/strict');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError, ConflictError, FeedbackError } = require(path.join(ROOT, 'dist/src/core'));
const { attachHook, attachJavaHook, attachIl2CppHook, ManagedHookFailure, observeModule } = require(path.join(ROOT, 'dist/src/frida'));
const cases = [];
const results = [];
let activeComparisons;
function display(value) {
    let data;
    try {
        data = JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? `${v}n` : v);
    }
    catch {
        data = require('node:util').inspect(value, { depth: 4 });
    }
    return String(data).slice(0, 1500);
}
const check = (actual, expected, message = '') => {
    if (activeComparisons)
        activeComparisons.push({ label: message || `assertion-${activeComparisons.length + 1}`, expected: display(expected), observed: display(actual), match: require('node:util').isDeepStrictEqual(actual, expected) });
    A.deepStrictEqual(actual, expected, message);
};
const read = (d, store) => d.inline(ctx => ctx.read(store));
const failed = e => e instanceof Error ? `${e.name}: ${e.message}` : String(e);
function test(area, name, fn, kind = 'contract') { cases.push({ area, name, fn, kind }); }
function fixture(initial = {}) {
    const errors = [];
    return { d: new Dispatcher({ onError: e => errors.push(failed(e)), ...initial }), errors };
}
function handler(run, when = () => true) { return new class extends Handler {
    when(ctx) { return when(ctx); }
    run(ctx) { return run(ctx); }
}; }
function timeout(p, ms = 3000) {
    let id;
    return Promise.race([p, new Promise((_, reject) => { id = setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms`)), ms); })]).finally(() => clearTimeout(id));
}
function javaFixture() {
    let impl = null;
    let originals = 0;
    const method = { handle: { toString: () => '0xbeef' }, get implementation() { return impl; }, set implementation(fn) { impl = fn; }, call(_receiver, ...a) { originals++; return (a[0] ?? 0) * 2; } };
    const bridge = { perform(fn) { fn(); }, use() { return { calc: { overload: () => method } }; } };
    return { bridge, method, invoke(arg, receiver = {}) { return (impl ?? function (v) { return method.call(this, v); }).call(receiver, arg); }, get originals() { return originals; } };
}
function ilFixture() {
    let originals = 0;
    const method = { implementation: null, invoke(...args) { originals++; return args[0] * 3; }, revert() { this.implementation = null; } };
    const bridge = { perform(fn) { fn(); }, domain: { assembly() { return { image: { class() { return { method() { return method; } }; } } }; } } };
    return { bridge, method, get originals() { return originals; } };
}
function nativeFixture() {
    let listener;
    let detached = false;
    const runtime = { Interceptor: { attach(addr, callbacks) { if (addr !== 0x1000)
                throw new Error('bad addr'); listener = callbacks; return { detach() { detached = true; } }; } } };
    return { runtime, enter(id, args = []) { const self = { threadId: id }; listener.onEnter.call(self, args); return self; }, leave(self, initial = -13) { const ret = { value: initial, replace(v) { this.value = v; } }; listener.onLeave.call(self, ret); return ret.value; }, get detached() { return detached; } };
}
// Modules receive only an explicit harness; no suite reaches into the runner's bookkeeping.
const kit = {
    A, Dispatcher, Handler, Context, PostCommitReactionError, BufferOverflowError,
    ConflictError, FeedbackError, attachHook, attachJavaHook, attachIl2CppHook,
    ManagedHookFailure, observeModule, check, read, failed, test, fixture, handler,
    timeout, javaFixture, ilFixture, nativeFixture,
};
require("./integration/suites/business.cjs")(kit);
require("./integration/suites/events.cjs")(kit);
require("./integration/suites/conflicts.cjs")(kit);
require("./integration/suites/causality.cjs")(kit);
require("./integration/suites/adapters.cjs")(kit);
require("./integration/suites/stress.cjs")(kit);
require("./integration/suites/workflows.cjs")(kit);
require("./integration/suites/safety.cjs")(kit);
async function main() {
    const start = Date.now();
    for (let index = 0; index < cases.length; index++) {
        const item = cases[index];
        const began = Date.now();
        activeComparisons = [];
        try {
            await timeout(Promise.resolve().then(() => item.fn()), 10000);
            results.push({ id: index + 1, area: item.area, name: item.name, kind: item.kind, status: 'PASS', ms: Date.now() - began, comparisons: activeComparisons });
            console.log(`PASS ${String(index + 1).padStart(2, '0')} [${item.area}] ${item.name}`);
        }
        catch (error) {
            results.push({ id: index + 1, area: item.area, name: item.name, kind: item.kind, status: 'FAIL', ms: Date.now() - began, error: failed(error), detail: error?.stack || String(error), comparisons: activeComparisons });
            console.log(`FAIL ${String(index + 1).padStart(2, '0')} [${item.area}] ${item.name} — ${failed(error)}`);
        }
    }
    const counts = { total: cases.length, passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status === 'FAIL').length, byArea: {} };
    for (const r of results) {
        const c = counts.byArea[r.area] ||= { passed: 0, failed: 0 };
        c[r.status === 'PASS' ? 'passed' : 'failed']++;
    }
    const report = { project: ROOT, version: '0.1.18', node: process.version, started: new Date(start).toISOString(), elapsedMs: Date.now() - start, summary: counts, results };
    const output = path.join(__dirname, 'results.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`SUMMARY ${counts.passed}/${counts.total} passed, ${counts.failed} failed; ${Date.now() - start}ms; ${output}`);
    if (counts.failed)
        process.exitCode = 1;
}
main().catch(err => { console.error('FATAL', err); process.exitCode = 2; });
