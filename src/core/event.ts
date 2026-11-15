/** Typed, transactional event source. Unlike Store, Event holds NO latest value. */
import type { Dispatcher } from "./dispatcher";
import { copyAndFreeze } from "./state/value-snapshot";

export interface EventOptions { storage?: "immutable" | "reference" }

export class Event<T> {
  constructor(
    readonly id: number,
    readonly owner: Dispatcher,
    readonly storage: "immutable" | "reference",
  ) { Object.freeze(this); }

  /** Internal: copy before publication so later caller mutations cannot change a queued event. */
  _prepare(value: T): T {
    return this.storage === "reference" ? value : copyAndFreeze(value);
  }
}

/** An absent event is undefined; a present event with value undefined is { value: undefined }. */
export interface EventOccurrence<T> { readonly value: Readonly<T> }
