/** Handler registration lifecycle, subscriptions and exactly-once cleanup. */
import type { Dispatcher } from "../dispatcher";
import { Event } from "../event";
import type { Handler } from "../handler";
import type { AnyEvent } from "../internal";
import {
  Registration, deactivateRegistration, beginRegistrationCleanup,
  endRegistrationCleanup, completeRegistrationCleanup,
} from "../registration";
import { RegistrationSetupError } from "../errors";
import { expectSynchronous } from "../internal/contracts-runtime";
import type { RegistrationOptions } from "../types";
import type { StateTable } from "../state/state-table";
import type { SubscriptionIndex } from "./subscriptions";
import type { ConflictResolver } from "./conflicts";
import type { WorkQueue } from "../scheduling/work-queue";
import type { TransactionGuard } from "../transactions/transaction-guard";
import type { RegistrationSchedulingPort } from "../internal/ports";
import { planRegistration } from "./registration-config";

/** Exclusivity is global: one Handler instance cannot register on two dispatchers. */
const activeHandlers = new WeakMap<Handler, Registration>();

export class RegistrationManager {
  private nextRegistrationId = 1;

  constructor(
    private readonly owner: Dispatcher,
    private readonly state: StateTable,
    private readonly subscriptions: SubscriptionIndex,
    private readonly conflicts: ConflictResolver,
    private readonly work: WorkQueue,
    private readonly guard: TransactionGuard,
    private readonly scheduler: RegistrationSchedulingPort,
    private readonly assertEvent: (event: AnyEvent) => void,
  ) {}

  /** Register one Handler and optionally enqueue its initial execution.
   * @returns A frozen lifecycle handle; only dispose/unregister ends its ownership.
   * @throws {RegistrationSetupError} If failed inline setup also fails cleanup.
   * @sideEffects Subscribes to sources, tracks exclusivity, enqueues work and may run inline handlers.
   */
  register(handler: Handler, options: RegistrationOptions = {}): Registration {
    this.guard.assertReady("register");
    if (activeHandlers.has(handler)) {
      throw new Error("Handler instance already has an active registration; create another instance or dispose the old registration");
    }
    const plan = planRegistration(handler, options);
    for (const source of plan.sources) {
      if (source instanceof Event) this.assertEvent(source);
      else this.state.assertRegistered(source);
    }
    const reg = new Registration(
      this.nextRegistrationId++, this.owner, handler, plan.sources,
      plan.mode, plan.delivery, plan.execution, plan.buffer,
    );
    activeHandlers.set(handler, reg);
    try {
      this.subscriptions.register(reg);
      if (plan.initial) {
        const snapshot = this.state.snapshot();
        this.scheduler.enqueue({
          reg, snapshot,
          cause: this.scheduler.activeEffectCause?.root() ?? this.scheduler.newCause(),
          beforeRevision: snapshot.revision,
          preImage: new Map(), changes: new Map(),
        });
      }
      if (plan.execution === "inline") this.scheduler.flushInline();
      return reg;
    } catch (error) {
      try { this.unregister(reg); }
      catch (cleanupError) { throw new RegistrationSetupError(reg, error, cleanupError); }
      throw error;
    }
  }

  /** Stop all incoming jobs before executing fallible cleanup callbacks.
   * @sideEffects Deactivates registration, subscriptions, rules, and queued work.
   */
  deactivate(reg: Registration): void {
    this.guard.assertReady("unregister");
    if (reg.owner !== this.owner) throw new Error("Registration belongs to another dispatcher");
    if (!reg.active) return;
    deactivateRegistration(reg);
    this.subscriptions.unregister(reg);
    this.conflicts.unregister(reg);
    this.work.cancel(reg);
    this.scheduler.settleWaiters();
  }

  /** Release a registration; failed onDispose can be retried.
   * @sideEffects Calls Handler.onDispose synchronously, and releases global exclusivity on success.
   */
  unregister(reg: Registration): void {
    this.guard.assertReady("unregister");
    this.deactivate(reg);
    if (reg.cleanupInProgress) return;
    if (!reg.cleanupComplete) {
      beginRegistrationCleanup(reg);
      try {
        expectSynchronous(reg.handler.onDispose(), "Handler.onDispose");
        completeRegistrationCleanup(reg);
      } finally {
        endRegistrationCleanup(reg);
      }
    }
    if (activeHandlers.get(reg.handler) === reg) activeHandlers.delete(reg.handler);
  }
}
