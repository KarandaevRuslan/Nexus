"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDiningSimulation = createDiningSimulation;
const core_1 = require("nexus/core");
const invariants_1 = require("../domain/invariants");
const table_1 = require("../domain/table");
const clock_handler_1 = require("./handlers/clock-handler");
const fork_arbiter_1 = require("./handlers/fork-arbiter");
const observers_1 = require("./handlers/observers");
/** Composition root only: rules belong to domain/ and individual handlers/. */
function createDiningSimulation(config = { count: 5, eatMs: 1500, seed: 42 }) {
    (0, table_1.validateConfig)(config);
    let lastError;
    const listeners = new Set();
    const mealListeners = new Set();
    const dispatcher = new core_1.Dispatcher({
        onError(error) { lastError = error; },
        maxInlineWaves: 128,
        maxCausalWaves: 2048,
    });
    const scope = dispatcher.scope();
    const table = scope.store((0, table_1.makeTable)(config));
    const pulse = scope.event();
    const rebalance = scope.event();
    const mealStarted = scope.event();
    let latest = dispatcher.inline(ctx => ctx.read(table));
    let disposed = false;
    function publish(value) {
        (0, invariants_1.checkTableInvariants)(value);
        latest = value;
        for (const listener of [...listeners])
            listener(value);
    }
    scope.register(new clock_handler_1.ClockHandler(table, pulse, rebalance));
    scope.register(new fork_arbiter_1.ForkArbiter(table, rebalance, mealStarted));
    scope.register(new observers_1.TableObserver(table, publish, scope));
    scope.register(new observers_1.MealStartedObserver(mealStarted, event => {
        for (const listener of [...mealListeners])
            listener(event);
    }, scope));
    function transact(change) {
        if (disposed)
            throw new Error("Simulation has been disposed");
        dispatcher.inline(ctx => {
            const previous = ctx.read(table);
            const next = change(previous);
            if (next !== previous)
                ctx.set(table, next);
        });
    }
    return {
        get snapshot() { return latest; },
        get lastError() { return lastError; },
        subscribe(listener) {
            if (disposed)
                throw new Error("Simulation has been disposed");
            listeners.add(listener);
            listener(latest);
            return () => { listeners.delete(listener); };
        },
        subscribeMealStarted(listener) {
            if (disposed)
                throw new Error("Simulation has been disposed");
            mealListeners.add(listener);
            return () => { mealListeners.delete(listener); };
        },
        start() { transact(table_1.startTable); },
        pause() { transact(table_1.pauseTable); },
        resume() { transact(table_1.resumeTable); },
        stop() { transact(table_1.stopTable); },
        tick(elapsedMs) {
            if (disposed)
                throw new Error("Simulation has been disposed");
            if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 1 || elapsedMs > 100_000) {
                throw new RangeError("elapsedMs must be an integer from 1 to 100000");
            }
            if (latest.status !== "running")
                return;
            dispatcher.inline(ctx => ctx.emit(pulse, { elapsedMs }));
        },
        configure(nextConfig) {
            (0, table_1.validateConfig)(nextConfig);
            transact(old => {
                if (old.status !== "stopped")
                    throw new Error("Stop before changing count or seed");
                return (0, table_1.makeTable)(nextConfig);
            });
        },
        setEatDuration(eatMs) { transact(old => (0, table_1.changeEatDuration)(old, eatMs)); },
        clearLogs() { transact(old => ({ ...old, logs: [] })); },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            scope.dispose();
            listeners.clear();
            mealListeners.clear();
        },
    };
}
