/** Reverse index of Store changes and typed Event occurrences. */
import { Event } from "../event";
import type { AnyStore, AnyEvent, AnyChange, Snapshot, Job, CommitFrame, Emission } from "../internal";
import { observeRegistrationSource, type Registration } from "../registration";
import type { CausalChain } from "../scheduling/causality";

export class SubscriptionIndex {
  private readonly subscribers = new Map<AnyStore, Set<Registration>>();
  private readonly eventSubscribers = new Map<AnyEvent, Set<Registration>>();

  addStore(store: AnyStore): void { this.subscribers.set(store, new Set()); }
  addEvent(event: AnyEvent): void { this.eventSubscribers.set(event, new Set()); }
  hasSubscribers(store: AnyStore): boolean { return (this.subscribers.get(store)?.size ?? 0) > 0; }
  hasEventSubscribers(event: AnyEvent): boolean { return (this.eventSubscribers.get(event)?.size ?? 0) > 0; }
  removeStore(store: AnyStore): void { this.subscribers.delete(store); }
  removeEvent(event: AnyEvent): void { this.eventSubscribers.delete(event); }

  register(reg: Registration): void {
    for (const source of reg.sources) {
      const list = source instanceof Event ? this.eventSubscribers.get(source) : this.subscribers.get(source);
      if (!list) throw new Error(`Source #${source.id} not registered`);
      list.add(reg);
    }
  }
  unregister(reg: Registration): void {
    for (const source of reg.sources) {
      const list = source instanceof Event ? this.eventSubscribers.get(source) : this.subscribers.get(source);
      list?.delete(reg);
    }
  }

  /** One State Store notification schedules an 'any' Handler at most once per Commit. */
  storeWake(frame: CommitFrame): Set<Registration> {
    const wake = new Set<Registration>();
    for (const change of frame.changes) for (const reg of this.subscribers.get(change.store) ?? []) {
      if (!reg.active) continue;
      if (reg.mode === "any") wake.add(reg);
      else if (observeRegistrationSource(reg, change.store)) wake.add(reg);
    }
    return wake;
  }

  /** Conservative preflight without mutating on.all accumulation bits. */
  previewStoreWake(frame: CommitFrame): Set<Registration> {
    const wake = new Set<Registration>();
    for (const change of frame.changes) for (const reg of this.subscribers.get(change.store) ?? []) {
      if (reg.active && reg.mode === "any") wake.add(reg);
    }
    return wake;
  }

  eventWake(event: AnyEvent): readonly Registration[] {
    return [...(this.eventSubscribers.get(event) ?? [])].filter(reg => reg.active);
  }

  publish(frame: CommitFrame, snapshot: Snapshot, cause: CausalChain, enqueue: (job: Job) => void): void {
    if (!frame.changes.length) return;
    const changed = new Map<AnyStore, AnyChange>(frame.changes.map(change => [change.store, change]));
    for (const reg of this.storeWake(frame)) enqueue({
      reg, snapshot, cause, changes: changed,
      beforeRevision: frame.beforeRevision, preImage: frame.preImage,
    });
  }

  publishEvent(emission: Emission, snapshot: Snapshot, cause: CausalChain, enqueue: (job: Job) => void): void {
    for (const reg of this.eventWake(emission.source)) enqueue({
      reg, snapshot, cause, emission, changes: new Map(),
      beforeRevision: snapshot.revision, preImage: new Map(),
    });
  }
}
