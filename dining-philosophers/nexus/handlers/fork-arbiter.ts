import { Context, Handler, type Event, type Store } from "nexus/core";
import { allocateForks } from "../../domain/allocator";
import type { TableState } from "../../domain/types";
import type { Rebalance } from "./clock-handler";

export interface MealStarted { readonly philosopherId: number; readonly at: number }

/** The only Handler authorized to allocate forks; grants both atomically. */
export class ForkArbiter extends Handler {
  constructor(
    private readonly state: Store<TableState>,
    rebalance: Event<Rebalance>,
    private readonly mealStarted: Event<MealStarted>,
  ) {
    super({ on: { any: [rebalance] }, execution: "inline", delivery: "each" });
  }

  override run(ctx: Context): void {
    const current = ctx.read(this.state);
    const allocation = allocateForks(current);
    if (!allocation.started.length) return;
    ctx.set(this.state, allocation.state);
    for (const philosopherId of allocation.started) {
      ctx.emit(this.mealStarted, { philosopherId, at: current.timeMs });
    }
  }
}
