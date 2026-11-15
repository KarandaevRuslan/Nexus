"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClockHandler = void 0;
const core_1 = require("nexus/core");
const table_1 = require("../../domain/table");
/** Clock events are processed transactionally; no timers live in this Handler. */
class ClockHandler extends core_1.Handler {
    state;
    pulse;
    rebalance;
    constructor(state, pulse, rebalance) {
        super({ on: { any: [pulse] }, execution: "inline", delivery: "each" });
        this.state = state;
        this.pulse = pulse;
        this.rebalance = rebalance;
    }
    run(ctx) {
        const pulse = ctx.event(this.pulse);
        if (!pulse)
            return;
        const previous = ctx.read(this.state);
        if (previous.status !== "running")
            return;
        const updated = (0, table_1.advanceTable)(previous, pulse.value.elapsedMs);
        ctx.set(this.state, updated.state);
        if (updated.rebalance)
            ctx.emit(this.rebalance, { timeMs: updated.state.timeMs });
    }
}
exports.ClockHandler = ClockHandler;
