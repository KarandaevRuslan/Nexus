import { Context, Handler, type Event, type Store } from "nexus/core";
import { advanceTable } from "../../domain/table";
import type { TableState } from "../../domain/types";

export interface Pulse { readonly elapsedMs: number }
export interface Rebalance { readonly timeMs: number }

/** Clock events are processed transactionally; no timers live in this Handler. */
export class ClockHandler extends Handler {
  constructor(
    private readonly state: Store<TableState>,
    private readonly pulse: Event<Pulse>,
    private readonly rebalance: Event<Rebalance>,
  ) {
    super({ on: { any: [pulse] }, execution: "inline", delivery: "each" });
  }

  override run(ctx: Context): void {
    const pulse = ctx.event(this.pulse);
    if (!pulse) return;
    const previous = ctx.read(this.state);
    if (previous.status !== "running") return;
    const updated = advanceTable(previous, pulse.value.elapsedMs);
    ctx.set(this.state, updated.state);
    if (updated.rebalance) ctx.emit(this.rebalance, { timeMs: updated.state.timeMs });
  }
}
