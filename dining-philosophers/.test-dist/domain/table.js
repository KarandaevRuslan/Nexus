"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
exports.appendLog = appendLog;
exports.makeTable = makeTable;
exports.startTable = startTable;
exports.pauseTable = pauseTable;
exports.resumeTable = resumeTable;
exports.stopTable = stopTable;
exports.advanceTable = advanceTable;
exports.changeEatDuration = changeEatDuration;
const random_1 = require("./random");
const LOG_LIMIT = 160;
function validateConfig(config) {
    if (!Number.isSafeInteger(config.count) || config.count < 3 || config.count > 10) {
        throw new RangeError("philosophers must be between 3 and 10");
    }
    if (!Number.isSafeInteger(config.eatMs) || config.eatMs < 100 || config.eatMs > 10000) {
        throw new RangeError("eatMs must be between 100 and 10000");
    }
    if (!Number.isSafeInteger(config.seed))
        throw new RangeError("seed must be a safe integer");
}
function appendLog(state, message, kind, philosopherId) {
    const entry = { id: state.logSequence + 1, at: state.timeMs, message, kind, philosopherId };
    return {
        ...state,
        logs: [...state.logs.slice(-(LOG_LIMIT - 1)), entry],
        logSequence: entry.id,
    };
}
function makeTable(config) {
    validateConfig(config);
    const philosophers = Array.from({ length: config.count }, (_, index) => ({
        id: index + 1, phase: "thinking", seat: null, dueAt: null, waitingSince: null,
        meals: 0, totalWaitMs: 0, maxWaitMs: 0,
    }));
    return {
        status: "stopped", count: config.count, seed: config.seed, eatMs: config.eatMs,
        timeMs: 0, forks: Array(config.count).fill(null), seats: Array(config.count).fill(null),
        philosophers, queue: [], totalMeals: 0, maxConcurrentEating: 0, logs: [], logSequence: 0,
    };
}
function startTable(old) {
    if (old.status !== "stopped")
        return old;
    const reset = makeTable({ count: old.count, seed: old.seed, eatMs: old.eatMs });
    return appendLog({
        ...reset, status: "running",
        philosophers: reset.philosophers.map(p => ({
            ...p, dueAt: (0, random_1.randomIndex)(Math.max(1, reset.eatMs), reset.seed, p.id, 17),
        })),
    }, "Simulation started", "system");
}
function pauseTable(state) {
    return state.status === "running"
        ? appendLog({ ...state, status: "paused" }, "Simulation paused", "system")
        : state;
}
function resumeTable(state) {
    return state.status === "paused"
        ? appendLog({ ...state, status: "running" }, "Simulation resumed", "system")
        : state;
}
function stopTable(state) {
    if (state.status === "stopped")
        return state;
    return appendLog(makeTable({ count: state.count, eatMs: state.eatMs, seed: state.seed }), "Simulation stopped; forks and seats released", "system");
}
/** Pure state transition for a single virtual-clock pulse. */
function advanceTable(state, elapsedMs) {
    if (state.status !== "running")
        return { state, rebalance: false };
    const now = state.timeMs + elapsedMs;
    let next = { ...state, timeMs: now };
    const forks = [...state.forks];
    const seats = [...state.seats];
    const philosophers = state.philosophers.map(p => ({ ...p }));
    const queue = [...state.queue];
    let mealCount = state.totalMeals;
    let changed = false;
    // A completed meal relinquishes BOTH forks and its seat in one immutable update.
    for (let index = 0; index < philosophers.length; index++) {
        const p = philosophers[index];
        if (p.phase !== "eating" || p.dueAt === null || p.dueAt > now)
            continue;
        const seat = p.seat;
        if (forks[seat] !== p.id || forks[(seat + 1) % state.count] !== p.id) {
            throw new Error(`Invalid fork ownership during release for philosopher ${p.id}`);
        }
        forks[seat] = null;
        forks[(seat + 1) % state.count] = null;
        seats[seat] = null;
        mealCount++;
        philosophers[index] = {
            ...p, phase: "thinking", seat: null, waitingSince: null,
            meals: p.meals + 1,
            dueAt: now + (0, random_1.thinkDuration)(state.seed, p.id, p.meals + 1, state.eatMs),
        };
        next = appendLog(next, `P${p.id} finished meal #${p.meals + 1}; released forks ${seat + 1} & ${(seat + 1) % state.count + 1}`, "finished", p.id);
        changed = true;
    }
    // Seat selection preserves the old Java application's random-free-seat behavior.
    // All philosophers share an equal number of seats; waiting-seat is still modelled explicitly.
    for (let index = 0; index < philosophers.length; index++) {
        const p = philosophers[index];
        if (p.phase !== "waiting-seat" && (p.phase !== "thinking" || p.dueAt === null || p.dueAt > now))
            continue;
        const available = seats.map((owner, i) => owner === null ? i : -1).filter(i => i !== -1);
        if (available.length === 0) {
            if (p.phase === "thinking") {
                philosophers[index] = { ...p, phase: "waiting-seat", dueAt: null, waitingSince: now };
                next = appendLog(next, `P${p.id} is waiting for a free seat`, "waiting", p.id);
                changed = true;
            }
            continue;
        }
        const seat = available[(0, random_1.randomIndex)(available.length, state.seed, p.id, p.meals, state.timeMs)];
        seats[seat] = p.id;
        philosophers[index] = {
            ...p, phase: "waiting-forks", seat, dueAt: null,
            waitingSince: p.waitingSince ?? now,
        };
        queue.push(p.id);
        next = appendLog(next, `P${p.id} took seat ${seat + 1}; waiting for both forks`, "seat", p.id);
        changed = true;
    }
    next = { ...next, forks, seats, philosophers, queue, totalMeals: mealCount };
    return { state: next, rebalance: changed || queue.length > 0 };
}
function changeEatDuration(state, eatMs) {
    validateConfig({ count: state.count, seed: state.seed, eatMs });
    return appendLog({ ...state, eatMs }, `Eating duration changed to ${eatMs} ms`, "system");
}
