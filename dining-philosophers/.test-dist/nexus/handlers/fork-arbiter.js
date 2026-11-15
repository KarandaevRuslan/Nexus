"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForkArbiter = void 0;
const core_1 = require("nexus/core");
const allocator_1 = require("../../domain/allocator");
/** The only Handler authorized to allocate forks; grants both atomically. */
class ForkArbiter extends core_1.Handler {
    state;
    mealStarted;
    constructor(state, rebalance, mealStarted) {
        super({ on: { any: [rebalance] }, execution: "inline", delivery: "each" });
        this.state = state;
        this.mealStarted = mealStarted;
    }
    run(ctx) {
        const current = ctx.read(this.state);
        const allocation = (0, allocator_1.allocateForks)(current);
        if (!allocation.started.length)
            return;
        ctx.set(this.state, allocation.state);
        for (const philosopherId of allocation.started) {
            ctx.emit(this.mealStarted, { philosopherId, at: current.timeMs });
        }
    }
}
exports.ForkArbiter = ForkArbiter;
