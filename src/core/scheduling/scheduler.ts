/** Causally scoped command and reaction scheduling. No state publication logic. */
import { CausalChain } from "./causality";
import type { Context } from "../context";
import { FeedbackError } from "../errors";
import { expectSynchronous } from "../internal/contracts-runtime";
import type { Job } from "../internal";
import type { Scope } from "../scope";
import type { WorkQueue } from "./work-queue";
import type { TransactionGuard } from "../transactions/transaction-guard";
import type { ErrorSink, ScheduleExecutorPort } from "../internal/ports";
import { DEFAULT_LIMITS } from "../internal/defaults";

interface CompletionWaiter {
  readonly cause: CausalChain;
  resolve(): void;
  reject(error: unknown): void;
}

export class Scheduler {
  private readonly completionWaiters = new Set<CompletionWaiter>();
  private nextCauseId = 1;
  private currentCause?: CausalChain;
  private currentEffectCause?: CausalChain;
  private executor?: ScheduleExecutorPort;
  get activeCause(): CausalChain | undefined { return this.currentCause; }
  get activeEffectCause(): CausalChain | undefined { return this.currentEffectCause; }
  private consecutiveCommands = 0;
  private inlineDrainDepth = 0;
  private inlineWavesInDrain = 0;
  private scheduled = false;

  constructor(
    private readonly work: WorkQueue,
    private readonly guard: TransactionGuard,
    private readonly reporter: ErrorSink,
    private readonly limits: Readonly<{
      maxInlineWaves: number;
      maxWavesPerTurn: number;
      maxCommandsBeforeDeferred: number;
      maxCausalWaves: number;
    }>,
  ) {}

  /** Bind after TransactionEngine and WaveExecutor are fully constructed.
   * @throws {Error} On a second binding attempt.
   * @sideEffects Publishes a single, read-only executor port to the scheduler.
   */
  connect(executor: ScheduleExecutorPort): void {
    if (this.executor) throw new Error("Scheduler executor is already connected");
    if (!executor || typeof executor.context !== "function" || typeof executor.commit !== "function" ||
        typeof executor.processNextGroup !== "function") {
      throw new TypeError("Scheduler executor port is incomplete");
    }
    this.executor = Object.freeze({ ...executor });
  }

  /** Fail explicitly if used before composition finishes; never read a half-built Dispatcher. */
  private get transactions(): ScheduleExecutorPort {
    if (!this.executor) throw new Error("Scheduler used before executor bootstrap");
    return this.executor;
  }

  /** Own and restore the active cause across speculative wave execution.
   * @sideEffects Temporarily changes the scheduler lineage even on a thrown error.
   */
  withActiveCause<T>(cause: CausalChain, operation: () => T): T {
    void this.transactions; // enforce completed composition before service use
    const previous = this.currentCause;
    this.currentCause = cause;
    try { return operation(); }
    finally { this.currentCause = previous; }
  }

  /** Allocate a root cause. The caller decides whether to inherit an active cause.
   * @sideEffects Increments the dispatcher-local cause identifier.
   */
  newCause(): CausalChain {
    void this.transactions; // enforce completed composition before service use
    return new CausalChain(this.nextCauseId++);
  }

  /** Run one effect with its committed cause inherited by nested operations.
   * @sideEffects Temporarily changes active effect lineage; always restores it.
   */
  withEffectCause<T>(cause: CausalChain, callback: () => T): T {
    void this.transactions; // enforce completed composition before service use
    const previous = this.activeEffectCause;
    this.currentEffectCause = cause;
    try { return callback(); }
    finally { this.currentEffectCause = previous; }
  }

  /** Queue a command and return after its own commit, not all descendants.
   * @sideEffects Enqueues command and schedules a deferred timer.
   */
  submit<R>(fn: (ctx: Context) => R, owner?: Scope): Promise<R> {
    return this.enqueueTrackedCommand(fn, owner).result;
  }

  /** Await this command and its synchronous/deferred causal descendants.
   * @sideEffects Adds a transient completion waiter; unrelated roots are not awaited.
   */
  submitAndWait<R>(fn: (ctx: Context) => R, owner?: Scope): Promise<R> {
    const { result, cause } = this.enqueueTrackedCommand(fn, owner);
    return result.then(async value => {
      await this.waitForCause(cause);
      return value;
    });
  }

  /** Cancel unstarted commands of one Scope and settle affected waiters.
   * @sideEffects Rejects pending promises.
   */
  cancelScopeCommands(owner: Scope): void {
    void this.transactions; // enforce completed composition before service use
    this.work.cancelCommandsOwnedBy(owner);
    this.settleWaiters();
  }

  /** Enqueue a Handler reaction. Deferred work is scheduled automatically.
   * @sideEffects May coalesce, drop, or reject according to the registration buffer.
   */
  enqueue(job: Job): void {
    void this.transactions; // enforce completed composition before service use
    this.work.enqueue(job);
    if (job.reg.execution === "deferred") this.schedule();
  }

  private enqueueTrackedCommand<R>(fn: (ctx: Context) => R, owner?: Scope): { result: Promise<R>; cause: CausalChain } {
    this.guard.assertReady("submit");
    const cause = this.activeEffectCause?.root() ?? this.newCause();
    const result = new Promise<R>((resolve, reject) => {
      this.work.commands.push({ fn, owner, cause, resolve: value => resolve(value as R), reject });
      this.schedule();
    });
    return { result, cause };
  }

  private waitForCause(cause: CausalChain): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.completionWaiters.add({ cause, resolve, reject });
      this.settleWaiters();
    });
  }

  /** Settle only lineages without queued or currently executing descendants.
   * @sideEffects Resolves/rejects completion promises; never runs during a draft commit.
   */
  settleWaiters(): void {
    void this.transactions; // enforce completed composition before service use
    for (const waiter of this.completionWaiters) {
      const root = waiter.cause.root();
      if (this.activeCause?.root() === root ||
          this.activeEffectCause?.root() === root ||
          this.work.hasCause(root)) continue;
      this.completionWaiters.delete(waiter);
      if (root.failure !== undefined || root.stopped) {
        waiter.reject(root.failure ?? new FeedbackError(`Causal chain #${root.id} stopped`));
      } else {
        waiter.resolve();
      }
    }
  }

  /** Drain manually with an explicit limit; unlike timer turns, overflow throws.
   * @sideEffects Processes commands, commits and reactions synchronously.
   */
  flush(maxWaves: number = DEFAULT_LIMITS.manualFlushWaves): void {
    void this.transactions; // enforce completed composition before service use
    this.guard.assertReady("flush");
    try { this.drain(maxWaves, false); }
    finally { this.settleWaiters(); }
  }

  /** Drain bounded urgent inline reactions, including reentrant committed effects.
   * @throws {FeedbackError} After safety limits; pending inline descendants are discarded.
   * @sideEffects May commit writes, execute handlers, and settle causal waiters.
   */
  flushInline(): void {
    void this.transactions; // enforce completed composition before service use
    if (this.inlineDrainDepth > 0 && !this.activeEffectCause) return;
    if (this.inlineDrainDepth === 0) this.inlineWavesInDrain = 0;
    if (this.inlineDrainDepth >= this.limits.maxInlineWaves) {
      this.work.discardAllInline();
      throw new FeedbackError("Nested inline reaction depth exceeded safety budget; pending inline jobs were discarded");
    }
    this.inlineDrainDepth++;
    let firstError: unknown;
    try {
      while (this.work.hasInline) {
        if (++this.inlineWavesInDrain > this.limits.maxInlineWaves) {
          this.work.discardAllInline();
          throw new FeedbackError("Inline reaction cycle exceeded safety budget; pending inline jobs were discarded");
        }
        try { this.transactions.processNextGroup("inline"); }
        catch (error) { firstError ??= error; }
      }
    } finally {
      this.inlineDrainDepth--;
      if (this.inlineDrainDepth === 0) {
        this.inlineWavesInDrain = 0;
        this.settleWaiters();
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Process work fairly: bounded commands between deferred waves.
   * @sideEffects Executes user code, commits, rejects failed commands, may enqueue effects.
   */
  private drain(maxWaves: number, yieldOnBudget: boolean): void {
    let waves = 0;
    while (this.work.hasPending) {
      if (waves >= maxWaves) {
        if (yieldOnBudget) return;
        throw new FeedbackError("Deferred processing exceeded per-call wave budget (work remains queued)");
      }
      waves++;
      if (this.work.hasInline) {
        this.flushInline();
      } else if (this.work.hasDeferred &&
          (this.consecutiveCommands >= this.limits.maxCommandsBeforeDeferred || !this.work.commands.length)) {
        this.consecutiveCommands = 0;
        this.transactions.processNextGroup("deferred");
        this.flushInline();
      } else if (this.work.commands.length) {
        const command = this.work.commands.shift()!;
        if (command.cause.root().stopped || (command.owner && !command.owner.active)) {
          command.reject(new Error("Command canceled before execution"));
          continue;
        }
        const cause = command.cause.root();
        if (++cause.waves > this.limits.maxCausalWaves) {
          const error = new FeedbackError(`Causal chain #${cause.id} exceeded ${this.limits.maxCausalWaves} work steps`);
          command.reject(error);
          this.work.discardCause(cause, error);
          this.reporter.report(error);
          continue;
        }
        this.consecutiveCommands++;
        const previousCause = this.currentCause;
        this.currentCause = cause;
        const ctx = this.transactions.context();
        try {
          const value = this.guard.evaluate(() => {
            const value = command.fn(ctx);
            expectSynchronous(value, "Dispatcher.submit callback");
            return value;
          });
          this.transactions.commit([ctx]);
          command.resolve(value);
        } catch (error) {
          command.reject(error);
        } finally {
          ctx._close();
          this.currentCause = previousCause;
        }
        this.flushInline();
      }
    }
  }

  /** Schedule one zero-delay timer; preserve fairness across timer turns.
   * @sideEffects Starts a timer and reports asynchronous errors.
   */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      try { this.drain(this.limits.maxWavesPerTurn, true); }
      catch (error) { this.reporter.report(error); }
      finally {
        this.settleWaiters();
        if (this.work.hasPending) this.schedule();
      }
    }, DEFAULT_LIMITS.schedulerDelayMs);
  }
}
