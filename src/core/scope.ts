import type { Dispatcher } from "./dispatcher";
import type { Context } from "./context";
import type { Handler } from "./handler";
import type { AnyStore, AnyEvent } from "./internal";
import { Event } from "./event";
import type { EventOptions } from "./event";
import type { RegistrationOptions } from "./types";
import { Registration } from "./registration";
import { RegistrationSetupError } from "./errors";
import { expectSynchronous } from "./internal/contracts-runtime";
import { Store } from "./store";
import type { StoreOptions } from "./store";
import { ScopeRelations } from "./lifecycle/scope-relations";
import { releaseLifo } from "./lifecycle/release-lifo";

/** Owner of registrations, Stores and external cleanup callbacks. */
export class Scope {
  private readonly registrations: Registration[] = [];
  private readonly stores: AnyStore[] = [];
  private readonly events: AnyEvent[] = [];
  private readonly cleanups: Array<() => void> = [];
  /** Graph bookkeeping is separate from the resource cleanup protocol. */
  readonly #relations = new ScopeRelations(this);
  private disposed = false;
  private disposing = false;
  private closing = false;
  constructor(private readonly dispatcher: Dispatcher) {}

  get active(): boolean { return !this.closing && !this.disposed && !this.disposing; }

  /** Internal ownership check for effects, without exposing mutable Scope internals. */
  _belongsTo(dispatcher: Dispatcher): boolean { return this.dispatcher === dispatcher; }

  /** Create an owned child whose teardown precedes the parent's resources.
   * Ownership and dependency are distinct: outside borrowers still block the
   * parent, but owned children are disposed by the parent automatically.
   * @returns A new child owning the same dispatcher, depending on this Scope.
   * @sideEffects Adds a child and borrowing edge to the lifetime graph.
   */
  child(): Scope {
    this.assertActive();
    this.dispatcher._assertConfigurationMutable("Scope.child");
    const child = new Scope(this.dispatcher);
    child.dependsOn(this);
    this.#relations.addChild(child);
    return child;
  }

  /** Declare that this Scope uses resources owned by another Scope.
   * Owner disposal is blocked until this Scope finishes successful cleanup.
   * This is explicit; reading a Store does NOT acquire a hidden dependency.
   * @throws {Error} For foreign/inactive owners or dependency cycles.
   * @sideEffects Adds a borrowing edge; no Store references are implicitly tracked.
   */
  dependsOn(owner: Scope): void {
    this.assertActive();
    if (!(owner instanceof Scope) || owner.dispatcher !== this.dispatcher) {
      throw new Error("Scope dependency must belong to the same Dispatcher");
    }
    this.#relations.dependsOn(owner);
  }

  /** Scope-owned command: if it has not started when dispose() is called,
   * it is removed from the scheduler and its Promise rejects. If executing,
   * the usual synchronous transaction semantics apply (no preemption).
   * @sideEffects Queues a command tied to this Scope's lifetime.
   */
  submit<R>(fn: (ctx: Context) => R): Promise<R> {
    if (!this.active) return Promise.reject(new Error("Scope is not active"));
    return this.dispatcher._submitScoped(this, fn);
  }

  /** Await a Scope-owned command and its causal Nexus descendants only.
   * @sideEffects Queues cancellable work and a causal completion waiter.
   */
  submitAndWait<R>(fn: (ctx: Context) => R): Promise<R> {
    if (!this.active) return Promise.reject(new Error("Scope is not active"));
    return this.dispatcher._submitScopedAndWait(this, fn);
  }

  /** Guard a callback from a foreign timer or event source. It becomes a no-op
   * once teardown starts. The caller is still responsible for canceling the
   * underlying timer/listener via cleanup().
   * @returns An entry-guarded wrapper, not an asynchronous cancellation mechanism.
   * @sideEffects Calls the wrapped callback only while the Scope is active.
   */
  guard<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
    this.assertActive();
    if (typeof fn !== "function") throw new TypeError("Scope.guard expects a function");
    return (...args: Args): void => { if (this.active) fn(...args); };
  }

  /** Create and own a Store, released automatically on dispose().
   * @sideEffects Registers the Store and pushes it onto this Scope's LIFO stack.
   */
  store<T>(initial: T, options: StoreOptions<T> = {}): Store<T> {
    this.assertActive();
    const s = this.dispatcher.store(initial, options);
    this.stores.push(s);
    return s;
  }
  /** Create and own an Event source, released after owned Stores.
   * @sideEffects Registers the source and adds it to Scope cleanup.
   */
  event<T>(options: EventOptions = {}): Event<T> {
    this.assertActive();
    const event = this.dispatcher.event<T>(options);
    this.events.push(event);
    return event;
  }
  /** Register and own a Handler; failed initialization may retain retryable cleanup.
   * @sideEffects Subscribes, may execute inline initialization, tracks lifetime.
   */
  register(handler: Handler, options: RegistrationOptions = {}): Registration {
    this.assertActive();
    let reg: Registration;
    try {
      reg = this.dispatcher.register(handler, options);
    } catch (error) {
      // A failed initial run may also fail to dispose its Handler. Take
      // ownership of that deactivated Registration, even though register()
      // never returned normally, so Scope.dispose() can retry cleanup.
      if (error instanceof RegistrationSetupError) {
        this.registrations.push(error.registration);
        this.disposed = false;
      }
      throw error;
    }
    if (!this.active) {
      // An initial inline run may dispose this Scope BEFORE register() returns.
      // The new registration is then not yet in this.registrations, so the
      // Scope must explicitly roll it back instead of leaking a live Handler.
      try { reg.dispose(); }
      catch (cleanupError) {
        // Track the failed cleanup for retry even if the Scope was already
        // marked disposed: clearing disposed re-enables dispose() retries.
        this.registrations.push(reg);
        this.disposed = false;
        throw new AggregateError([cleanupError], "Scope closed during registration and rollback failed");
      }
      throw new Error("Scope was disposed during Handler registration");
    }
    this.registrations.push(reg);
    return reg;
  }
  /** Register an external synchronous cleanup, executed in reverse order.
   * @sideEffects Appends callback to the LIFO disposal phase.
   */
  cleanup(fn: () => void): void {
    this.assertActive();
    if (typeof fn !== "function") throw new TypeError("Scope.cleanup expects a function");
    this.cleanups.push(fn);
  }
  /** Strict LIFO teardown within each phase. Stop at the first failure so
   * later cleanup callbacks retain any resources on which they depend.
   * Already released resources are not attempted again; failures remain retryable.
   * @throws {AggregateError} If a cleanup phase fails; remaining resources survive for retry.
   * @sideEffects Cancels commands, deactivates handlers and releases owned resources.
   */
  dispose(): void {
    if (this.disposed) return;
    // All lifecycle mutations are administrative. In particular, a failed
    // transaction must not leave a Scope closed with its Stores still live.
    this.dispatcher._assertConfigurationMutable("Scope.dispose");
    if (this.disposing) throw new Error("Scope is already disposing");
    // Owned children are ours to close; independent borrowers are not. Reject
    // BEFORE changing active/closing, so an external owner can retry later.
    this.#relations.assertCanDispose();
    this.disposing = true;
    this.closing = true;
    // Pending commands must not access Stores after the Scope releases them.
    this.dispatcher._cancelScopeCommands(this);
    try {
      // Quiesce ALL registrations first, even if the first onDispose later
      // fails: a closed Scope must not keep scheduling its remaining handlers.
      // This is separate from running their retryable cleanup callbacks.
      for (const reg of this.registrations) this.dispatcher._deactivateRegistration(reg);
      // Dependency-ordered teardown: do NOT release external resources or
      // Stores while any Handler cleanup is pending. That cleanup may still
      // need to read the Stores owned by this Scope. Successful cleanups are
      // removed individually and are not repeated on the next attempt.
      // Owned children may borrow this Scope's Stores. Release them before
      // parent handlers, cleanups, or Stores, while preserving strict LIFO
      // and retrying the failed child on the next dispose() call.
      this.#relations.disposeChildren();
      releaseLifo(this.registrations, reg => reg.dispose(), "Handler");
      releaseLifo(this.cleanups, fn => expectSynchronous(fn(), "Scope.cleanup callback"), "external");
      releaseLifo(this.stores, store => this.dispatcher.unregisterStore(store), "Store");
      releaseLifo(this.events, event => this.dispatcher.unregisterEvent(event), "Event");
      this.disposed = true;
      this.#relations.release();
    } finally {
      this.disposing = false;
    }
  }
  private assertActive(): void {
    if (!this.active) throw new Error("Scope is disposed or disposing");
  }
}
