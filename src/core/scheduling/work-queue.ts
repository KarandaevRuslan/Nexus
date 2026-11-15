/** Job buffering and chronological wave selection. Does not execute user code. */
import { BufferOverflowError } from "../errors";
import type { Job, Command } from "../internal";
import { countDroppedJob, type Registration } from "../registration";
import type { Execution } from "../types";
import type { CausalChain } from "./causality";
import type { Scope } from "../scope";

export class WorkQueue {
  readonly commands: Command[] = [];
  private readonly inlineJobs: Job[] = [];
  private readonly deferredJobs: Job[] = [];
  private readonly latestInline = new Map<Registration, Job>();
  private readonly latestDeferred = new Map<Registration, Job>();
  private readonly pendingEach = new Map<Registration, number>();

  get hasPending(): boolean {
    return Boolean(this.commands.length || this.inlineJobs.length || this.deferredJobs.length);
  }
  get hasInline(): boolean { return this.inlineJobs.length > 0; }
  get hasDeferred(): boolean { return this.deferredJobs.length > 0; }

  private queueFor(reg: Registration): Job[] {
    return reg.execution === "inline" ? this.inlineJobs : this.deferredJobs;
  }

  /** Used before StateTable applies a commit, so reject cannot lose a committed event. */
  assertCapacity(reg: Registration, additional = 1): void {
    if (reg.delivery !== "each" || reg.buffer.overflow !== "reject") return;
    if ((this.pendingEach.get(reg) ?? 0) + additional > reg.buffer.capacity) {
      throw new BufferOverflowError(`Subscription #${reg.id} has ${reg.buffer.capacity} pending events`);
    }
  }

  hasCause(cause: CausalChain): boolean {
    const root = cause.root();
    return this.commands.some(command => command.cause.root() === root) ||
      this.inlineJobs.some(job => job.cause.root() === root) ||
      this.deferredJobs.some(job => job.cause.root() === root);
  }

  private removed(job: Job): void {
    const latest = job.reg.execution === "inline" ? this.latestInline : this.latestDeferred;
    if (latest.get(job.reg) === job) latest.delete(job.reg);
    if (job.reg.delivery === "each") {
      const count = (this.pendingEach.get(job.reg) ?? 0) - 1;
      if (count <= 0) this.pendingEach.delete(job.reg);
      else this.pendingEach.set(job.reg, count);
    }
  }

  private removeWhere(predicate: (job: Job) => boolean): void {
    for (const queue of [this.inlineJobs, this.deferredJobs]) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const job = queue[i]!;
        if (!predicate(job)) continue;
        queue.splice(i, 1);
        this.removed(job);
      }
    }
  }

  cancel(reg: Registration): void {
    this.removeWhere(job => job.reg === reg);
  }

  /** A separate inline safety budget must not leave orphaned inline jobs. */
  discardAllInline(): void {
    const roots = new Set(this.inlineJobs.map(job => job.cause.root()));
    for (const root of roots) root.stopped = true;
    // Includes deferred descendants of the offending inline chains.
    this.removeWhere(job => roots.has(job.cause.root()));
  }

  discardCause(cause: CausalChain, reason: Error = new Error("Causal chain stopped")): void {
    const root = cause.root();
    root.stopped = true;
    this.removeWhere(job => job.cause.root() === root);
    // Commands also form part of the same causal lineage. Otherwise a command
    // can endlessly reschedule itself through post-commit effects.
    this.removeCommands(command => command.cause.root() === root, reason);
  }

  cancelCommandsOwnedBy(owner: Scope): void {
    this.removeCommands(command => command.owner === owner, new Error("Scope disposed: pending command canceled"));
  }

  private removeCommands(predicate: (command: Command) => boolean, reason: Error): void {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const command = this.commands[i]!;
      if (!predicate(command)) continue;
      this.commands.splice(i, 1);
      command.reject(reason);
    }
  }

  enqueue(job: Job): void {
    const reg = job.reg;
    if (!reg.active || job.cause.root().stopped) return;
    const queue = this.queueFor(reg);
    const latest = reg.execution === "inline" ? this.latestInline : this.latestDeferred;
    if (reg.delivery === "latest") {
      const existing = latest.get(reg);
      if (existing) {
        existing.cause = existing.cause.merge(job.cause);
        // Restoring an aborted older job must not overwrite a newer coalesced
        // event that has arrived in the meantime.
        if (job.snapshot.revision >= existing.snapshot.revision) {
          existing.snapshot = job.snapshot;
          existing.beforeRevision = job.beforeRevision;
          existing.preImage = job.preImage;
          existing.changes = job.changes;
          existing.emission = job.emission;
        }
      } else {
        latest.set(reg, job);
        queue.push(job);
      }
      return;
    }

    const count = this.pendingEach.get(reg) ?? 0;
    if (count >= reg.buffer.capacity) {
      const policy = reg.buffer.overflow;
      if (policy === "reject") {
        // Normally caught by pre-commit admission. Also protects initial/request jobs.
        throw new BufferOverflowError(`Subscription #${reg.id} has ${reg.buffer.capacity} pending events`);
      }
      countDroppedJob(reg);
      if (policy === "drop-newest") return;
      const index = queue.findIndex(pending => pending.reg === reg);
      if (index < 0) throw new Error("Inconsistent pending event count");
      const old = queue.splice(index, 1)[0]!;
      this.removed(old);
    }
    queue.push(job);
    this.pendingEach.set(reg, (this.pendingEach.get(reg) ?? 0) + 1);
  }

  /** Requeue jobs extracted in a wave but not committed because a peer failed.
   * The failed job itself is excluded by the caller to avoid an infinite retry loop.
   */
  restore(jobs: readonly Job[]): void {
    for (const job of jobs) this.enqueue(job);
  }

  takeNextGroup(execution: Execution): Job[] {
    const queue = execution === "inline" ? this.inlineJobs : this.deferredJobs;
    if (!queue.length) return [];

    // An older slot may contain a newer coalesced revision.
    let firstIndex = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i]!.snapshot.revision < queue[firstIndex]!.snapshot.revision) firstIndex = i;
    }
    const first = queue.splice(firstIndex, 1)[0]!;
    this.removed(first);
    const group = [first];
    for (let i = 0; i < queue.length;) {
      if (queue[i]!.snapshot.revision !== first.snapshot.revision ||
          group.some(chosen => chosen.reg === queue[i]!.reg)) {
        i++;
        continue;
      }
      const job = queue.splice(i, 1)[0]!;
      this.removed(job);
      group.push(job);
    }
    return group;
  }
}
