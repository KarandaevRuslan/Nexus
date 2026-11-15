import type { Dispatcher } from "./dispatcher";
import { copyAndFreeze } from "./state/value-snapshot";

/** Reference mode is an explicit escape hatch for opaque runtime objects (e.g. NativePointer).
 * In reference mode the caller owns immutability, and historical reads are NOT protected
 * against mutations of the referenced object.
 */
export interface StoreOptions<T> {
  equals?: (a: T, b: T) => boolean;
  storage?: "immutable" | "reference";
}

export class Store<T> {
  // A typed handle, not a container: only Context may read/write its value.
  constructor(
    readonly id: number,
    readonly owner: Dispatcher,
    readonly equals: (a: T, b: T) => boolean,
    readonly storage: "immutable" | "reference",
  ) {
    // Store is a descriptor. Its comparator, owner and identity never change.
    // In particular JavaScript code cannot replace equals() inside an aborted transaction.
    Object.freeze(this);
  }

  /** INTERNAL: stabilize a value before entering the table or a transaction draft. */
  _prepare(value: T): T {
    return this.storage === "reference" ? value : copyAndFreeze(value);
  }
}

/** A commit notification is metadata; values belong to the revision's snapshots.
 * 'touched' means an explicit record:'always' request produced a notification,
 * despite equality of the committed values.
 */
export interface Change<T> {
  readonly store: Store<T>;
  readonly revision: number;
  readonly version: number;
  readonly kind: "changed" | "touched";
}
