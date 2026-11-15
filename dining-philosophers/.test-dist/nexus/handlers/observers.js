"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MealStartedObserver = exports.TableObserver = void 0;
const core_1 = require("nexus/core");
/** Post-commit read model for React: UI never owns or mutates the Store. */
class TableObserver extends core_1.Handler {
    state;
    publish;
    scope;
    constructor(state, publish, scope) {
        super({ on: { any: [state] }, execution: "inline", delivery: "latest" });
        this.state = state;
        this.publish = publish;
        this.scope = scope;
    }
    run(ctx) {
        const snapshot = ctx.read(this.state);
        ctx.effect(() => this.publish(snapshot), { owner: this.scope });
    }
}
exports.TableObserver = TableObserver;
/** Separate event consumer illustrates that multiple Nexus components can observe a single fact. */
class MealStartedObserver extends core_1.Handler {
    handle;
    scope;
    constructor(source, handle, scope) {
        super({ on: { any: [source] }, execution: "inline", delivery: "each" });
        this.handle = handle;
        this.scope = scope;
        this.source = source;
    }
    source;
    run(ctx) {
        const occurrence = ctx.event(this.source);
        if (!occurrence)
            return;
        const value = occurrence.value;
        ctx.effect(() => this.handle(value), { owner: this.scope });
    }
}
exports.MealStartedObserver = MealStartedObserver;
