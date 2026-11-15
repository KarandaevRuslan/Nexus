import type { Dispatcher } from "./dispatcher";
import type { Store, Change } from "./store";
import type { WriteOptions } from "./types";
import { Scope } from "./scope";
import type { Registration } from "./registration";
import type { Event, EventOccurrence } from "./event";
import type { AnyStore, AnyChange, Cell, Snapshot, PreImage, Emission, Signal } from "./internal";

/** Consistent committed read view. No access to transaction drafts. */
export interface ReadSnapshot {
  readonly revision: number;
  read<T>(store: Store<T>): Readonly<T>;
  version<T>(store: Store<T>): number;
}

/** Restricted capability handed to Handler.when(). Unlike Context this is a
 * separate runtime object, not merely a TypeScript type alias.
 */
export interface ReadContext {
  readonly revision: number;
  readonly before: ReadSnapshot;
  readonly after: ReadSnapshot;
  read<T>(store: Store<T>): Readonly<T>;
  version<T>(store: Store<T>): number;
  change<T>(store: Store<T>): Change<T> | undefined;
  /** Event payload for THIS invocation, not a persistent state value. */
  event<T>(source: Event<T>): EventOccurrence<T> | undefined;
}

/** Scope ownership is explicit; Handler effects are also tied to the
 * originating Registration by default. "independent" opts out of ONLY the
 * Registration lifetime, not an explicitly provided Scope owner.
 */
export interface EffectOptions {
  readonly owner?: Scope;
  readonly lifetime?: "registration" | "independent";
}

export interface PostCommitEffect {
  readonly callback: () => unknown;
  readonly owner?: Scope;
  readonly origin?: Registration;
}

/** Origin bookkeeping is not a method on user-facing Context. */
const effectOrigins = new WeakMap<Context, Registration>();

/** INTERNAL: bind before evaluating a Handler. Not exported through core/index. */
export function bindContextEffectOrigin(ctx: Context, reg: Registration): void {
  const current = effectOrigins.get(ctx);
  if (current && current !== reg) {
    throw new Error("Context already belongs to another Handler registration");
  }
  effectOrigins.set(ctx, reg);
}

export class Context implements ReadContext {
  private readonly drafts = new Map<AnyStore, { value: any; force: boolean }>();
  private readonly reads = new Set<AnyStore>();
  private readonly effects: PostCommitEffect[] = [];
  private readonly signals: Signal[] = [];
  private active = true;

  /** `before` and `after` surround the SAME commit that produced this job.
   * Manual/initial executions have no associated commit: both are identical.
   * A 'latest' job refers to the LAST coalesced commit, not the whole interval.
   */
  readonly before: ReadSnapshot;
  readonly after: ReadSnapshot;
  private readonly readOnlyView: ReadContext;

  constructor(
    private readonly dispatcher: Dispatcher,
    readonly revision: number,
    private readonly snapshot: Snapshot,
    private readonly notifications: ReadonlyMap<AnyStore, AnyChange>,
    private readonly preImage: PreImage = new Map(),
    beforeRevision: number = snapshot.revision,
    private readonly workingSnapshot: Snapshot = snapshot,
    private readonly emission?: Emission,
  ) {
    const makeView = (rev: number, before: boolean): ReadSnapshot => Object.freeze({
      revision: rev,
      read: <T>(store: Store<T>): Readonly<T> => {
        const cell = this.viewCell(store, before);
        this.reads.add(store);
        return cell.value as Readonly<T>;
      },
      version: <T>(store: Store<T>): number => {
        const cell = this.viewCell(store, before);
        this.reads.add(store);
        return cell.version;
      },
    });
    this.before = makeView(beforeRevision, true);
    this.after = makeView(snapshot.revision, false);
    // NO Context prototype, writes, updates, effect registration or private
    // dispatcher references are exposed to the predicate. Even an unsafe cast
    // cannot conjure the missing mutator methods at runtime.
    this.readOnlyView = Object.freeze({
      revision: this.revision,
      before: this.before,
      after: this.after,
      read: <T>(store: Store<T>): Readonly<T> => this.read(store),
      version: <T>(store: Store<T>): number => this.version(store),
      change: <T>(store: Store<T>): Change<T> | undefined => this.change(store),
      event: <T>(source: Event<T>): EventOccurrence<T> | undefined => this.event(source),
    });
  }

  /** Return the capability-restricted view used by Handler.when().
   * @returns A frozen object exposing reads and metadata but no mutators.
   * @throws {Error} If the transaction Context has expired.
   * @sideEffects None.
   */
  asReadOnly(): ReadContext {
    this.assertActive();
    return this.readOnlyView;
  }

  private assertActive(): void {
    if (!this.active) throw new Error("Context expired: do not keep it across await or callbacks");
  }

  private viewCell(store: AnyStore, before: boolean): Cell {
    this.assertActive();
    this.dispatcher._assertStoreRegistered(store);
    const cell = (before && this.preImage.get(store)) || this.snapshot.cells.get(store);
    if (!cell) throw new Error(`Store #${store.id} is not registered in this snapshot`);
    return cell;
  }

  private workingCell(store: AnyStore): Cell {
    this.assertActive();
    this.dispatcher._assertStoreRegistered(store);
    const cell = this.workingSnapshot.cells.get(store);
    if (!cell) throw new Error(`Store #${store.id} is not registered in this snapshot`);
    return cell;
  }

  /** Read from the execution view (which may include prior speculative writes
   * during sequence), or from this Context's own drafts.  before/after remain
   * fixed to the ORIGINAL triggering commit.
   * @returns The own draft if present, otherwise the speculative execution value.
   * @throws {Error} When the Context or Store is no longer valid.
   * @sideEffects Tracks the read for optimistic validation; does not mutate Store state.
   */
  read<T>(store: Store<T>): Readonly<T> {
    this.assertActive();
    this.reads.add(store);
    const draft = this.drafts.get(store);
    return draft ? draft.value as Readonly<T> : this.workingCell(store).value as Readonly<T>;
  }

  /** Return the Store version in the current execution snapshot.
   * @sideEffects Tracks the read for optimistic validation.
   */
  version<T>(store: Store<T>): number {
    const cell = this.workingCell(store);
    this.reads.add(store);
    return cell.version;
  }

  /** Stage a Store write in this transaction (not yet committed).
   * @throws {Error | TypeError} For invalid options, Store ownership or expired Context.
   * @sideEffects Copies/freeze-prepares values and replaces the local draft; no publication.
   */
  set<T>(store: Store<T>, value: T, options: WriteOptions = {}): void {
    this.assertActive();
    if (options.record !== undefined && options.record !== "changed" && options.record !== "always") {
      throw new TypeError("record must be 'changed' or 'always'");
    }
    const base = this.workingCell(store).value;
    const old = this.drafts.get(store);
    const previous = old ? old.value : base;
    // Preserve identity for a true no-op assignment to the already-owned value.
    // New caller-owned structures are copied/frozen immediately, not at commit.
    const prepared = Object.is(previous, value) ? previous : store._prepare(value);
    this.drafts.set(store, {
      value: prepared,
      force: Boolean(old?.force || options.record === "always"),
    });
  }

  /** Compute and stage an update from this Context's latest visible value.
   * @sideEffects Calls `updater` synchronously; stores a local draft only.
   */
  update<T>(store: Store<T>, updater: (previous: Readonly<T>) => T, options: WriteOptions = {}): void {
    this.set(store, updater(this.read(store)), options);
  }

  /** Return metadata for the triggering Commit (never a coalesced history).
   * @sideEffects Validates the Store, but does not publish work.
   */
  change<T>(store: Store<T>): Change<T> | undefined {
    this.assertActive();
    this.viewCell(store, false);
    return this.notifications.get(store) as Change<T> | undefined;
  }

  /** Read the occurrence that triggered this Handler invocation, if any.
   * @returns `undefined` if the event did not trigger the current job.
   * @sideEffects Checks source registration; does not consume the occurrence.
   */
  event<T>(source: Event<T>): EventOccurrence<T> | undefined {
    this.assertActive();
    this.dispatcher._assertEventRegistered(source);
    if (this.emission?.source !== source) return undefined;
    return Object.freeze({ value: this.emission.value as Readonly<T> });
  }

  /** Stage an occurrence, published only if the entire Commit succeeds.
   * @sideEffects Copies the payload in immutable mode and adds a local signal.
   */
  emit<T>(source: Event<T>, value: T): void {
    this.assertActive();
    this.dispatcher._assertEventRegistered(source);
    this.signals.push({ kind: "emit", emission: { source, value: source._prepare(value) } });
  }

  /** Stage a Handler trigger without scheduling it before the Commit.
   * @sideEffects Adds a local signal; failed transactions discard it.
   */
  request(reg: Registration): void {
    this.assertActive();
    this.dispatcher._assertRequestTarget(reg);
    this.signals.push({ kind: "request", reg });
  }

  /** Post-commit effect. Async rejections go to Dispatcher.onError; they do
   * not block propagation or change the result of a committed transaction.
   * @throws {Error | TypeError} For invalid owner, lifetime or callback.
   * @sideEffects Stages the callback; it executes only after successful Commit.
   */
  effect(callback: () => void, options: EffectOptions = {}): void {
    this.assertActive();
    if (typeof callback !== "function") throw new TypeError("Context.effect expects a function");
    if (options.lifetime !== undefined && options.lifetime !== "registration" && options.lifetime !== "independent") {
      throw new TypeError("effect.lifetime must be 'registration' or 'independent'");
    }
    const owner = options.owner;
    if (owner !== undefined) {
      if (!(owner instanceof Scope) || !owner._belongsTo(this.dispatcher)) {
        throw new Error("Effect owner must be a Scope of the current Dispatcher");
      }
      if (!owner.active) throw new Error("Cannot register an effect for an inactive Scope");
    }
    this.effects.push({
      callback,
      owner,
      origin: options.lifetime === "independent" ? undefined : effectOrigins.get(this),
    });
  }

  _writes(): ReadonlyMap<AnyStore, { value: any; force: boolean }> { return this.drafts; }
  _reads(): ReadonlySet<AnyStore> { return this.reads; }
  _effects(): ReadonlyArray<PostCommitEffect> { return this.effects; }
  _signals(): readonly Signal[] { return this.signals; }
  _snapshot(): Snapshot { return this.workingSnapshot; }
  /** INTERNAL: merge a speculative Handler's reads, drafts and post-commit
   * effects into the single aggregate transaction. No effects run yet.
   * @sideEffects Merges staged reads, writes, signals and effects into this Context.
   */
  _adopt(other: Context): void {
    this.assertActive();
    for (const store of other._reads()) this.reads.add(store);
    for (const [store, write] of other._writes()) {
      const previous = this.drafts.get(store);
      this.drafts.set(store, { value: write.value, force: Boolean(write.force || previous?.force) });
    }
    this.effects.push(...other._effects());
    this.signals.push(...other._signals());
  }
  /** Invalidate all future Context access at the end of execution.
   * @sideEffects Closes the mutable transaction capability permanently.
   */
  _close(): void { this.active = false; }
}
