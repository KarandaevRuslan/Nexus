/** Commit and revision management. No scheduling or subscriptions live here. */
import { ConflictError } from "../errors";
import { expectBoolean } from "../internal/contracts-runtime";
import { Store } from "../store";
import type { StoreOptions } from "../store";
import type { Dispatcher } from "../dispatcher";
import type { Context } from "../context";
import type { AnyStore, AnyChange, Cell, Snapshot, CommitFrame } from "../internal";

export class StateTable {
  private revision = 0;
  private nextStoreId = 1;
  private readonly cells = new Map<AnyStore, Cell>();

  constructor(private readonly owner: Dispatcher) {}

  get currentRevision(): number { return this.revision; }

  createStore<T>(initial: T, options: StoreOptions<T>): Store<T> {
    const store = new Store<T>(this.nextStoreId++, this.owner, options.equals ?? Object.is, options.storage ?? "immutable");
    this.cells.set(store, { value: store._prepare(initial), version: 0 });
    return store;
  }

  assertRegistered(store: AnyStore): void {
    if (store.owner !== this.owner || !this.cells.has(store)) {
      throw new Error("Store is not registered in this dispatcher");
    }
  }

  removeStore(store: AnyStore): void {
    this.assertRegistered(store);
    this.cells.delete(store);
  }

  snapshot(): Snapshot {
    // One shallow table copy for a post-commit snapshot (existing v0.1 cost).
    // Values are detached and frozen by default; cells are never mutated in-place.
    return { revision: this.revision, cells: new Map(this.cells) };
  }

  /** Reject stale read/write snapshots before applying collision policy.
   * @throws {ConflictError} If a used Store's version has changed or disappeared.
   * @sideEffects None.
   */
  validateFresh(contexts: readonly Context[]): void {
    for (const ctx of contexts) {
      for (const store of ctx._reads()) {
        const original = ctx._snapshot().cells.get(store);
        if (original && this.cells.get(store)?.version !== original.version && ctx._writes().size) {
          throw new ConflictError(`Stale read of Store #${store.id}: snapshot ${ctx.revision}, now ${this.revision}`);
        }
      }
      for (const [store] of ctx._writes()) {
        const original = ctx._snapshot().cells.get(store);
        if (!original || !this.cells.has(store)) throw new ConflictError(`Disposed Store #${store.id}`);
        if (this.cells.get(store)!.version !== original.version) {
          throw new ConflictError(`Stale write to Store #${store.id}`);
        }
      }
    }
  }

  /** Produce metadata + only the previous cells of Stores affected by this commit.
   * Before is reconstructed from the post-snapshot overlaid with these pre-images.
   * @returns Revision metadata and pre-image of affected Store cells.
   * @throws {ConflictError} If speculative drafts collide or have stale versions.
   * @sideEffects Calls equals/preflight and atomically publishes cells after validation.
   */
  commit(contexts: readonly Context[], preflight?: (frame: CommitFrame) => void, forceRevision = false): CommitFrame {
    const pending = new Map<AnyStore, { value: any; force: boolean }>();
    this.validateFresh(contexts);
    for (const ctx of contexts) {
      for (const [store, write] of ctx._writes()) {
        if (pending.has(store)) throw new ConflictError(`Two handlers wrote Store #${store.id} in one wave`);
        pending.set(store, write);
      }
    }

    const changes: AnyChange[] = [];
    const preImage = new Map<AnyStore, Cell>();
    const beforeRevision = this.revision;
    const nextRevision = beforeRevision + 1;
    const nextCells = new Map<AnyStore, Cell>();
    for (const [store, write] of pending) {
      const old = this.cells.get(store)!;
      const equal = expectBoolean(store.equals(old.value, write.value), "Store.equals");
      const actualChange = !equal;
      if (!actualChange && !write.force) continue;
      changes.push({
        store,
        revision: nextRevision,
        version: old.version + 1,
        kind: actualChange ? "changed" : "touched",
      });
      preImage.set(store, old);
      nextCells.set(store, { value: write.value, version: old.version + 1 });
    }
    const frame: CommitFrame = { changes, preImage, beforeRevision };
    if (changes.length || forceRevision) preflight?.(frame);
    if (changes.length || forceRevision) {
      this.revision = nextRevision;
      for (const [store, cell] of nextCells) this.cells.set(store, cell);
    }
    return frame;
  }
}
