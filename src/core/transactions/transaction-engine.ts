/** Atomic commit admission/publication and post-commit effect delivery. */
import { Context } from "../context";
import type { AnyStore, AnyChange, AnyEvent, Snapshot, PreImage, Emission, CommitFrame } from "../internal";
import type { CommitOutcome } from "../types";
import type { Registration } from "../registration";
import type { StateTable } from "../state/state-table";
import type { CausalChain } from "../scheduling/causality";
import type { TransactionGuard } from "./transaction-guard";
import type { ContextFactory, CommitPublicationPort, BufferAdmissionPort, CommitSchedulingPort, ErrorSink } from "../internal/ports";

export class TransactionEngine {
  constructor(
    private readonly createContext: ContextFactory,
    private readonly state: StateTable,
    private readonly publication: CommitPublicationPort,
    private readonly admission: BufferAdmissionPort,
    private readonly guard: TransactionGuard,
    private readonly scheduler: CommitSchedulingPort,
    private readonly reporter: ErrorSink,
    private readonly assertRequestTarget: (reg: Registration) => void,
    private readonly assertEventRegistered: (event: AnyEvent) => void,
  ) {}

  /** Create a transaction tied to immutable triggering and execution snapshots.
   * @sideEffects Allocates a context; does not mutate committed state.
   */
  context(
    snapshot: Snapshot,
    changes: ReadonlyMap<AnyStore, AnyChange>,
    preImage: PreImage = new Map(),
    beforeRevision: number = snapshot.revision,
    workingSnapshot: Snapshot = snapshot,
    emission?: Emission,
  ): Context {
    return this.createContext(snapshot, changes, preImage, beforeRevision, workingSnapshot, emission);
  }

  /** Publish a single atomic revision and run valid effects only afterward.
   * @throws {Error} When preflight, comparison or state commit fails.
   * @sideEffects Updates Stores, schedules subscribers and invokes post-commit effects.
   */
  commit(contexts: readonly Context[]): CommitOutcome {
    // User-defined equals/preflight code runs during StateTable.commit(). Protect
    // the entire critical section so it cannot publish a nested revision while
    // the outer commit has already captured its intended next revision.
    this.guard.beginCommit();
    let frame: CommitFrame;
    // Reserve the cause before publishing, so all subscriptions and all
    // post-commit effects originate from the same lineage.
    const cause = this.scheduler.activeCause?.root() ?? this.scheduler.activeEffectCause?.root() ?? this.scheduler.newCause();
    try {
      const staged = contexts.flatMap(ctx => ctx._signals());
      // Preflight every additional 'each' job together. Reject-before-commit
      // remains atomic even for event-only or request-only transactions.
      frame = this.state.commit(contexts, candidate => {
        const projected = new Map<Registration, number>();
        const add = (reg: Registration): void => {
          if (reg.delivery === "each" && reg.active) projected.set(reg, (projected.get(reg) ?? 0) + 1);
        };
        for (const reg of this.publication.previewStoreWake(candidate)) add(reg);
        for (const signal of staged) {
          if (signal.kind === "request") {
            this.assertRequestTarget(signal.reg);
            add(signal.reg);
          } else {
            this.assertEventRegistered(signal.emission.source);
            for (const reg of this.publication.eventWake(signal.emission.source)) add(reg);
          }
        }
        for (const [reg, count] of projected) this.admission.assertCapacity(reg, count);
      }, staged.length > 0);
      if (frame.changes.length || staged.length) {
        this.publish(frame, cause);
        const snapshot = this.state.snapshot();
        for (const signal of staged) {
          if (signal.kind === "emit") {
            this.publication.publishEvent(signal.emission, snapshot, cause, job => this.scheduler.enqueue(job));
          } else {
            this.scheduler.enqueue({ reg: signal.reg, snapshot, cause,
              beforeRevision: snapshot.revision, preImage: new Map(), changes: new Map() });
          }
        }
      }
    } finally {
      this.guard.endCommit();
    }
    const committedRevision = this.state.currentRevision;
    for (const ctx of contexts) ctx._close();
    // Effects are strictly post-commit. An asynchronous effect does not block
    // inline propagation or submit(), and its rejection is still observed.
    for (const ctx of contexts) for (const effect of ctx._effects()) {
      // An earlier effect may have released a native resource. Never run a
      // later, explicitly owned effect after the Scope starts closing.
      if (effect.owner && !effect.owner.active) continue;
      // An earlier effect in this commit may have disposed the origin.
      if (effect.origin && !effect.origin.active) continue;
      this.scheduler.withEffectCause(cause, () => {
        try {
          const result = effect.callback();
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch(error => this.reporter.report(error));
          }
        } catch (error) { this.reporter.report(error); }
      });
    }
    return { revision: committedRevision, changes: frame.changes.length };
  }

  private publish(frame: CommitFrame, cause: CausalChain): void {
    const snapshot = this.state.snapshot();
    this.publication.publish(frame, snapshot, cause, job => this.scheduler.enqueue(job));
  }

}
