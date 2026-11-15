/** Execute a speculative Handler wave and resolve conflicts before publication. */
import { Context, bindContextEffectOrigin } from "../context";
import { expectBoolean, expectSynchronous } from "../internal/contracts-runtime";
import { FeedbackError } from "../errors";
import type { AnyStore, Job, Snapshot } from "../internal";
import type { Registration } from "../registration";
import type { Execution } from "../types";
import type { ConflictResolver } from "./conflicts";
import type { StateTable } from "../state/state-table";
import type { WorkQueue } from "../scheduling/work-queue";
import type { TransactionGuard } from "../transactions/transaction-guard";
import type { WaveTransactionsPort, WaveSchedulingPort } from "../internal/ports";

export class WaveExecutor {
  constructor(
    private readonly state: StateTable,
    private readonly work: WorkQueue,
    private readonly conflicts: ConflictResolver,
    private readonly guard: TransactionGuard,
    private readonly scheduler: WaveSchedulingPort,
    private readonly transactions: WaveTransactionsPort,
    private readonly maxCausalWaves: number,
  ) {}

  /** Execute a conflict-free wave in one Commit, or apply an explicit policy.
   * Speculative Handler invocations may be repeated when 'sequence' is chosen;
   * only ctx.effect() is protected from duplicate external execution.
   */
  processNextGroup(execution: Execution): void {
    const group = this.work.takeNextGroup(execution);
    if (!group.length) return;
    const jobs = group.filter(job => job.reg.active && !job.cause.root().stopped);
    if (!jobs.length) return;
    // When multiple roots participate in one wave, their outcomes become causally linked.
    const cause = jobs.slice(1).reduce((root, job) => root.merge(job.cause), jobs[0]!.cause).root();
    if (++cause.waves > this.maxCausalWaves) {
      const error = new FeedbackError(`Causal chain #${cause.id} exceeded ${this.maxCausalWaves} reactive waves`);
      this.work.discardCause(cause, error);
      throw error;
    }
    return this.scheduler.withActiveCause(cause, () => {
    const contexts: Context[] = [];
    try {
      // Event metadata/snapshots stay historical. State reads & writes use a fresh,
      // common execution snapshot, preventing stale accumulator updates.
      const executionSnapshot = this.state.snapshot();
      for (const job of jobs) {
        const ctx = this.transactions.context(job.snapshot, job.changes, job.preImage, job.beforeRevision, executionSnapshot, job.emission);
        contexts.push(ctx);
        try { this.runHandler(job, ctx); }
        catch (error) {
          // No speculative writes were committed. Rescue unaffected siblings;
          // never automatically retry the failed Handler (possibly non-idempotent).
          this.work.restore(jobs.filter(other => other !== job && other.reg.active));
          throw error;
        }
      }
      // Staleness remains an error, not a same-wave write collision.
      this.state.validateFresh(contexts);
      const resolution = this.conflicts.resolve(jobs, contexts);
      if (resolution.strategy === "skip") return; // No writes, effects or notifications.
      if (resolution.strategy === "parallel") {
        this.transactions.commit(contexts);
      } else {
        this.commitSequential(resolution.jobs);
      }
    } catch (error) {
      cause.root().failure ??= error;
      throw error;
    } finally {
      for (const ctx of contexts) ctx._close();
    }
    });
  }

  private runHandler(job: Job, ctx: Context): void {
    if (!job.reg.active) return;
    bindContextEffectOrigin(ctx, job.reg);
    this.guard.evaluate(() => {
      const admitted: unknown = job.reg.handler.when(ctx.asReadOnly());
      if (!expectBoolean(admitted, "Handler.when")) return;
      // when() may have disposed this registration through an external closure.
      if (!job.reg.active) return;
      const result: unknown = job.reg.handler.run(ctx);
      expectSynchronous(result, "Handler.run");
    });
  }

  /** Re-evaluate the entire conflicting wave in stable topological order.
   * Each Handler reads all earlier speculative writes through its execution
   * view.  No intermediate writes or notifications escape to the StateTable.
   * before/after/change remain tied to the original triggering commit.
   */
  private commitSequential(jobs: readonly Job[]): void {
    const base = this.state.snapshot();
    const combined = this.transactions.context(base, new Map());
    const previousWriters = new Map<AnyStore, Registration[]>();
    try {
      for (const job of jobs) {
        if (!job.reg.active) continue;
        const cells = new Map(base.cells);
        for (const [store, write] of combined._writes()) {
          const cell = cells.get(store);
          if (!cell) throw new Error(`Store #${store.id} disappeared during sequence`);
          // Speculative values have NOT advanced Store versions or revisions.
          cells.set(store, { value: write.value, version: cell.version });
        }
        const working: Snapshot = { revision: base.revision, cells };
        const ctx = this.transactions.context(
          job.snapshot, job.changes, job.preImage, job.beforeRevision, working, job.emission,
        );
        try {
          this.runHandler(job, ctx);
          // A guard may select different writes after prior speculative updates.
          // Require explicit ordering rules for newly overlapping writes too.
          for (const store of ctx._writes().keys()) {
            for (const earlier of previousWriters.get(store) ?? []) {
              if (this.conflicts.validateReplayPair(store, earlier, job.reg) === "skip") return;
            }
          }
          for (const store of ctx._writes().keys()) {
            const owners = previousWriters.get(store) ?? [];
            owners.push(job.reg);
            previousWriters.set(store, owners);
          }
          combined._adopt(ctx);
        } finally {
          ctx._close();
        }
      }
      this.transactions.commit([combined]); // One atomic published revision for the entire sequence.
    } finally {
      combined._close();
    }
  }

}
