import type { Dispatcher } from "./dispatcher";
import type { Handler } from "./handler";
import type { AnyStore, AnySource } from "./internal";
import type { Delivery, Execution, BufferOptions } from "./types";

type RegistrationState = {
  active: boolean;
  cleanupComplete: boolean;
  cleanupInProgress: boolean;
  droppedJobs: number;
  seen: Set<AnyStore>;
};

// Keep mutable bookkeeping outside the public Registration object. These
// fields must not be writable by arbitrary JavaScript inside a transaction.
const states = new WeakMap<Registration, RegistrationState>();
function stateOf(reg: Registration): RegistrationState {
  const state = states.get(reg);
  if (!state) throw new Error("Unknown Registration");
  return state;
}

export class Registration {
  readonly sources: readonly AnySource[];
  readonly buffer: Readonly<Required<BufferOptions>>;

  constructor(
    readonly id: number,
    readonly owner: Dispatcher,
    readonly handler: Handler,
    sources: readonly AnySource[],
    readonly mode: "any" | "all",
    readonly delivery: Delivery,
    readonly execution: Execution,
    buffer: Readonly<Required<BufferOptions>>,
  ) {
    this.sources = Object.freeze([...sources]);
    this.buffer = Object.freeze({ ...buffer });
    states.set(this, {
      active: true, cleanupComplete: false, cleanupInProgress: false,
      droppedJobs: 0, seen: new Set(),
    });
    Object.freeze(this);
  }

  get active(): boolean { return stateOf(this).active; }
  get cleanupComplete(): boolean { return stateOf(this).cleanupComplete; }
  get cleanupInProgress(): boolean { return stateOf(this).cleanupInProgress; }
  get droppedJobs(): number { return stateOf(this).droppedJobs; }

  /** Deactivate and dispose this registration via its owning Dispatcher.
   * @sideEffects Drops subscriptions and pending jobs; invokes onDispose synchronously.
   */
  dispose(): void { this.owner.unregister(this); }
}

// Module-internal operations: NOT exported from the public core/index facade,
// and not methods on the user-visible Registration handle. The WeakMap is the
// sole authority for runtime lifecycle state.
export function deactivateRegistration(reg: Registration): void { stateOf(reg).active = false; }
export function beginRegistrationCleanup(reg: Registration): void { stateOf(reg).cleanupInProgress = true; }
export function endRegistrationCleanup(reg: Registration): void { stateOf(reg).cleanupInProgress = false; }
export function completeRegistrationCleanup(reg: Registration): void { stateOf(reg).cleanupComplete = true; }
export function countDroppedJob(reg: Registration): void { stateOf(reg).droppedJobs++; }
export function observeRegistrationSource(reg: Registration, store: AnyStore): boolean {
  const state = stateOf(reg);
  state.seen.add(store);
  if (!reg.sources.every(source => state.seen.has(source as AnyStore))) return false;
  state.seen.clear();
  return true;
}
