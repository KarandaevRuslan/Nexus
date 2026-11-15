/** Stable public facade for transactional Stores, Events, Handlers and Scopes.
 * Internal registration, scheduling, waves and publication have separate owners.
 */
import { Context } from "./context";
import { Event } from "./event";
import type { EventOptions } from "./event";
import { ConflictResolver } from "./reactions/conflicts";
import { FeedbackError, PostCommitReactionError } from "./errors";
import { expectSynchronous } from "./internal/contracts-runtime";
import { validateConflictFallback } from "./reactions/validate-options";
import { Registration } from "./registration";
import { Scope } from "./scope";
import { StateTable } from "./state/state-table";
import { SubscriptionIndex } from "./reactions/subscriptions";
import { WorkQueue } from "./scheduling/work-queue";
import type { Store, StoreOptions } from "./store";
import type { AnyStore, AnyEvent } from "./internal";
import type { DispatcherOptions, RegistrationOptions } from "./types";
import type { Handler } from "./handler";
import { DEFAULT_LIMITS, DIAGNOSTIC_PREFIX, positiveBudget } from "./internal/defaults";
import { ErrorReporter } from "./diagnostics/error-reporter";
import { TransactionGuard } from "./transactions/transaction-guard";
import { RegistrationManager } from "./reactions/registration-manager";
import { Scheduler } from "./scheduling/scheduler";
import { TransactionEngine } from "./transactions/transaction-engine";
import { WaveExecutor } from "./reactions/wave-executor";

export class Dispatcher {
  private readonly state = new StateTable(this);
  readonly conflicts: ConflictResolver;
  private readonly subscriptions = new SubscriptionIndex();
  private readonly work = new WorkQueue();
  private readonly guard = new TransactionGuard();
  private readonly scheduler: Scheduler;
  private readonly transactions: TransactionEngine;
  private readonly registrations: RegistrationManager;
  private readonly reporter: ErrorReporter;
  private nextEventId = 1;
  private readonly registeredEvents = new Set<AnyEvent>();
  private inlineCallDepth = 0;
  private readonly maxInlineDepth: number;
  private readonly maxCausalWaves: number;

  /** Construct an independent dispatcher with bounded reactive propagation.
   * @throws {RangeError | TypeError} On invalid runtime limits or callbacks.
   * @sideEffects Allocates in-memory engines; does not start a timer.
   */
  constructor(options: DispatcherOptions = {}) {
    validateConflictFallback(options.conflictFallback);
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TypeError("onError must be a function");
    }
    const maxInlineWaves = positiveBudget("maxInlineWaves", options.maxInlineWaves ?? DEFAULT_LIMITS.inlineWaves);
    this.maxInlineDepth = positiveBudget("maxInlineDepth", options.maxInlineDepth ?? DEFAULT_LIMITS.inlineDepth);
    const maxWavesPerTurn = positiveBudget("maxWavesPerTurn", options.maxWavesPerTurn ?? DEFAULT_LIMITS.wavesPerTurn);
    const maxCommandsBeforeDeferred = positiveBudget("maxCommandsBeforeDeferred", options.maxCommandsBeforeDeferred ?? DEFAULT_LIMITS.commandsBeforeDeferred);
    this.maxCausalWaves = positiveBudget("maxCausalWaves", options.maxCausalWaves ?? DEFAULT_LIMITS.causalWaves);
    this.conflicts = new ConflictResolver(this, options.conflictFallback ?? "reject", store => this.state.assertRegistered(store));
    this.reporter = new ErrorReporter(options.onError ?? (error => { console.error(DIAGNOSTIC_PREFIX, error); }));
    // Two-phase bootstrap: a Scheduler cannot execute until the completed
    // engine and wave executor have both been connected exactly once.
    this.scheduler = new Scheduler(this.work, this.guard, this.reporter,
      { maxInlineWaves, maxWavesPerTurn, maxCommandsBeforeDeferred, maxCausalWaves: this.maxCausalWaves });
    const transactions = new TransactionEngine(
      (snapshot, changes, preImage, beforeRevision, workingSnapshot, emission) =>
        new Context(this, snapshot.revision, snapshot, changes, preImage, beforeRevision, workingSnapshot, emission),
      this.state, this.subscriptions, this.work, this.guard,
      this.scheduler, this.reporter,
      reg => this._assertRequestTarget(reg), event => this._assertEventRegistered(event),
    );
    const waves = new WaveExecutor(
      this.state, this.work, this.conflicts, this.guard,
      this.scheduler, transactions, this.maxCausalWaves,
    );
    this.transactions = transactions;
    this.scheduler.connect({
      context: () => transactions.context(this.state.snapshot(), new Map()),
      commit: contexts => { transactions.commit(contexts); },
      processNextGroup: execution => waves.processNextGroup(execution),
    });
    this.registrations = new RegistrationManager(
      this, this.state, this.subscriptions, this.conflicts, this.work,
      this.guard, this.scheduler, event => this._assertEventRegistered(event),
    );
  }

  /** Create a versioned Store owned by this dispatcher.
   * @returns A registered Store with the supplied initial value.
   * @sideEffects Adds Store to the state and subscription indexes; no revision is published.
   */
  store<T>(initial: T, options: StoreOptions<T> = {}): Store<T> {
    this.guard.assertReady("store");
    if (options.storage !== undefined && options.storage !== "immutable" && options.storage !== "reference") {
      throw new TypeError("storage must be 'immutable' or 'reference'");
    }
    if (options.equals !== undefined && typeof options.equals !== "function") {
      throw new TypeError("equals must be a function");
    }
    const store = this.state.createStore(initial, options);
    this.subscriptions.addStore(store);
    return store;
  }

  /** Create an Event source without a retained latest value.
   * @sideEffects Registers the source; emitted payloads are transactional.
   */
  event<T>(options: EventOptions = {}): Event<T> {
    this.guard.assertReady("event");
    if (options.storage !== undefined && options.storage !== "immutable" && options.storage !== "reference") {
      throw new TypeError("event.storage must be 'immutable' or 'reference'");
    }
    const event = new Event<T>(this.nextEventId++, this, options.storage ?? "immutable");
    this.registeredEvents.add(event);
    this.subscriptions.addEvent(event);
    return event;
  }

  /** Unregister an unsubscribed Event. @sideEffects Removes its index entry. */
  unregisterEvent(event: AnyEvent): void {
    this.guard.assertReady("unregisterEvent");
    this._assertEventRegistered(event);
    if (this.subscriptions.hasEventSubscribers(event)) {
      throw new Error(`Cannot unregister Event #${event.id}: active subscribers`);
    }
    this.registeredEvents.delete(event);
    this.subscriptions.removeEvent(event);
  }

  /** Create an independent, explicitly disposable resource owner. @sideEffects None. */
  scope(): Scope { return new Scope(this); }

  /** Register a Handler; may synchronously run its initial inline reaction.
   * @sideEffects Subscribes, enqueues work and invokes user code for inline initialization.
   */
  register(handler: Handler, options: RegistrationOptions = {}): Registration {
    return this.registrations.register(handler, options);
  }

  /** Internal Scope phase: deactivate before fallible onDispose callbacks.
   * @sideEffects Cancels queued jobs and removes subscriptions/rules.
   */
  _deactivateRegistration(reg: Registration): void { this.registrations.deactivate(reg); }

  /** Unregister a Handler and run retryable synchronous cleanup.
   * @sideEffects Calls handler.onDispose() once on successful completion.
   */
  unregister(reg: Registration): void { this.registrations.unregister(reg); }

  /** Delete an unsubscribed Store; it cannot be accessed by later Contexts.
   * @sideEffects Removes the Store and associated conflict rules.
   */
  unregisterStore(store: AnyStore): void {
    this.guard.assertReady("unregisterStore");
    this.state.assertRegistered(store);
    if (this.subscriptions.hasSubscribers(store)) {
      throw new Error(`Cannot unregister Store #${store.id}: active subscribers`);
    }
    this.state.removeStore(store);
    this.conflicts.unregisterStore(store);
    this.subscriptions.removeStore(store);
  }

  /** Execute and commit a synchronous transaction; may run inline descendants.
   * @returns The direct callback's return value (Promise-like values are rejected).
   * @throws {PostCommitReactionError} If inline propagation fails after a durable commit.
   * @sideEffects Publishes writes/events, invokes committed effects and inline Handlers.
   */
  inline<R>(fn: (ctx: Context) => R): R {
    this.guard.assertReady("inline");
    if (this.inlineCallDepth >= this.maxInlineDepth) {
      throw new FeedbackError(`Nested inline transaction depth exceeded ${this.maxInlineDepth}`);
    }
    this.inlineCallDepth++;
    try {
      const inherited = this.scheduler.activeEffectCause?.root();
      if (inherited && ++inherited.waves > this.maxCausalWaves) {
        const error = new FeedbackError(`Causal chain #${inherited.id} exceeded ${this.maxCausalWaves} work steps`);
        this.work.discardCause(inherited, error);
        throw error;
      }
      const ctx = this.transactions.context(this.state.snapshot(), new Map());
      let result!: R;
      let committedRevision: number;
      try {
        result = this.guard.evaluate(() => {
          const value = fn(ctx);
          expectSynchronous(value, "Dispatcher.inline callback");
          return value;
        });
        committedRevision = this.transactions.commit([ctx]).revision;
      } finally {
        ctx._close();
      }
      try { this.scheduler.flushInline(); }
      catch (cause) { throw new PostCommitReactionError(committedRevision, cause); }
      return result;
    } finally {
      this.inlineCallDepth--;
    }
  }

  /** Enqueue a command; resolves after its own Commit, not causal descendants.
   * @sideEffects Adds work and starts the deferred scheduler.
   */
  submit<R>(fn: (ctx: Context) => R): Promise<R> { return this.scheduler.submit(fn); }

  /** Enqueue a command; await its entire Nexus causal lineage.
   * @sideEffects Adds a completion waiter for descendants, excluding external async work.
   */
  submitAndWait<R>(fn: (ctx: Context) => R): Promise<R> { return this.scheduler.submitAndWait(fn); }

  /** Scope-owned command; rejects if the Scope is already inactive.
   * @sideEffects Queues cancellable work.
   */
  _submitScoped<R>(owner: Scope, fn: (ctx: Context) => R): Promise<R> {
    if (!owner.active) return Promise.reject(new Error("Scope is not active"));
    return this.scheduler.submit(fn, owner);
  }

  /** Scope-owned causal completion. @sideEffects Queues cancellable work. */
  _submitScopedAndWait<R>(owner: Scope, fn: (ctx: Context) => R): Promise<R> {
    if (!owner.active) return Promise.reject(new Error("Scope is not active"));
    return this.scheduler.submitAndWait(fn, owner);
  }

  /** Cancel commands that did not start before Scope teardown. */
  _cancelScopeCommands(owner: Scope): void { this.scheduler.cancelScopeCommands(owner); }

  /** Request a Handler outside a transaction using a snapshot of current state.
   * @sideEffects Enqueues a job and possibly executes it synchronously.
   */
  request(reg: Registration): void {
    this.guard.assertReady("request");
    if (reg.owner !== this || !reg.active) throw new Error("Unregistered handler");
    const snapshot = this.state.snapshot();
    this.scheduler.enqueue({
      reg, snapshot,
      cause: this.scheduler.activeEffectCause?.root() ?? this.scheduler.newCause(),
      beforeRevision: snapshot.revision, preImage: new Map(), changes: new Map(),
    });
    if (reg.execution === "inline") this.scheduler.flushInline();
  }

  /** Internal Context precondition. @throws {Error} For foreign/disposed Event sources. */
  _assertEventRegistered(event: AnyEvent): void {
    if (!(event instanceof Event) || event.owner !== this || !this.registeredEvents.has(event)) {
      throw new Error("Event is not registered in this dispatcher");
    }
  }

  /** Internal Context precondition. @throws {Error} For foreign/inactive registrations. */
  _assertRequestTarget(reg: Registration): void {
    if (!(reg instanceof Registration) || reg.owner !== this || !reg.active) {
      throw new Error("Unregistered or foreign handler");
    }
  }

  /** Drain all work up to the caller's wave budget.
   * @sideEffects May execute queued callbacks and publish transactions.
   */
  flush(maxWaves: number = DEFAULT_LIMITS.manualFlushWaves): void { this.scheduler.flush(maxWaves); }

  /** Guard entry point for Scope and conflict policy mutations. */
  _assertConfigurationMutable(operation: string): void { this.guard.assertReady(operation); }

  /** Forward errors from foreign runtime callbacks without throwing. */
  _reportExternalError(error: unknown): void { this.reporter.report(error); }

  /** Validate Context reads against the live Store registry. */
  _assertStoreRegistered(store: AnyStore): void { this.state.assertRegistered(store); }

  /** Current durable state revision; speculative writes are excluded. */
  get currentRevision(): number { return this.state.currentRevision; }
}
