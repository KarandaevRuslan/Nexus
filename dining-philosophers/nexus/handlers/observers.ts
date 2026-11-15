import { Context, Handler, type Event, type Scope, type Store } from "../../../src/core";
import type { TableState } from "../../domain/types";
import type { MealStarted } from "./fork-arbiter";

/** Post-commit read model for React: UI never owns or mutates the Store. */
export class TableObserver extends Handler {
  constructor(private readonly state: Store<TableState>, private readonly publish: (state: Readonly<TableState>) => void,
    private readonly scope: Scope) {
    super({ on: { any: [state] }, execution: "inline", delivery: "latest" });
  }

  override run(ctx: Context): void {
    const snapshot = ctx.read(this.state);
    ctx.effect(() => this.publish(snapshot), { owner: this.scope });
  }
}

/** Separate event consumer illustrates that multiple Nexus components can observe a single fact. */
export class MealStartedObserver extends Handler {
  constructor(source: Event<MealStarted>, private readonly handle: (event: MealStarted) => void, private readonly scope: Scope) {
    super({ on: { any: [source] }, execution: "inline", delivery: "each" });
    this.source = source;
  }
  private readonly source: Event<MealStarted>;

  override run(ctx: Context): void {
    const occurrence = ctx.event(this.source);
    if (!occurrence) return;
    const value = occurrence.value;
    ctx.effect(() => this.handle(value), { owner: this.scope });
  }
}
