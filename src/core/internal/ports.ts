/** Narrow inter-subsystem capabilities. The composition root owns all concrete instances. */
import type { Context } from "../context";
import type { Registration } from "../registration";
import type { CausalChain } from "../scheduling/causality";
import type { AnyStore, AnyChange, AnyEvent, Snapshot, PreImage, Emission, CommitFrame, Job } from "../internal";
import type { Execution } from "../types";

/** No timers or subscriptions: the scheduler drives a fully constructed executor. */
export interface ScheduleExecutorPort {
  context(): Context;
  commit(contexts: readonly Context[]): void;
  processNextGroup(execution: Execution): void;
}

/** Scheduling operations available to the atomic publisher (no timer control). */
export interface CommitSchedulingPort {
  readonly activeCause?: CausalChain;
  readonly activeEffectCause?: CausalChain;
  newCause(): CausalChain;
  enqueue(job: Job): void;
  withEffectCause<T>(cause: CausalChain, callback: () => T): T;
}

/** Read-only admission and notification publishing, provided by the reactions subsystem. */
export interface CommitPublicationPort {
  previewStoreWake(frame: CommitFrame): ReadonlySet<Registration>;
  eventWake(event: AnyEvent): readonly Registration[];
  publish(frame: CommitFrame, snapshot: Snapshot, cause: CausalChain, enqueue: (job: Job) => void): void;
  publishEvent(emission: Emission, snapshot: Snapshot, cause: CausalChain, enqueue: (job: Job) => void): void;
}

/** Queue buffer admission: publication may inspect capacity, not control work processing. */
export interface BufferAdmissionPort {
  assertCapacity(reg: Registration, count: number): void;
}

/** Fault reporting is best-effort and must not throw across the runtime boundary. */
export interface ErrorSink { report(error: unknown): void; }

/** A context is bound to the root Dispatcher identity without giving a service the facade. */
export type ContextFactory = (
  snapshot: Snapshot,
  changes: ReadonlyMap<AnyStore, AnyChange>,
  preImage: PreImage,
  beforeRevision: number,
  workingSnapshot: Snapshot,
  emission?: Emission,
) => Context;

/** Scheduling only: the wave executor may switch the current cause inside a finally-safe scope. */
export interface WaveSchedulingPort {
  withActiveCause<T>(cause: CausalChain, operation: () => T): T;
}

/** Context construction and durable commit; no wider TransactionEngine API. */
export interface WaveTransactionsPort {
  context(snapshot: Snapshot, changes: ReadonlyMap<AnyStore, AnyChange>, preImage?: PreImage,
    beforeRevision?: number, workingSnapshot?: Snapshot, emission?: Emission): Context;
  commit(contexts: readonly Context[]): void;
}

/** Handler lifecycle only: no direct transaction/commit control. */
export interface RegistrationSchedulingPort {
  readonly activeEffectCause?: CausalChain;
  newCause(): CausalChain;
  enqueue(job: Job): void;
  flushInline(): void;
  settleWaiters(): void;
}
