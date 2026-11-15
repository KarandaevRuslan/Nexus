/** Explicit conflict policies for independent Handler transactions in one wave.
 * This module NEVER commits user state and NEVER executes a Handler itself.
 */
import { ConflictError } from "../errors";
import type { Dispatcher } from "../dispatcher";
import type { Registration } from "../registration";
import type { Context } from "../context";
import type { Job, AnyStore } from "../internal";
import type { ConflictFallback, ConflictRule } from "../types";

export type Resolution =
  | { readonly strategy: "parallel" }
  | { readonly strategy: "skip" }
  | { readonly strategy: "sequence"; readonly jobs: readonly Job[] };

/** An installed rule can be released without affecting the registrations. */
/** Published handle contains an independently owned, frozen rule snapshot.
 * Active state lives in ConflictResolver, not on a writable public field.
 */
export class ConflictRuleHandle {
  constructor(readonly rule: ConflictRule, private readonly owner: ConflictResolver) {
    Object.freeze(this);
  }
  get active(): boolean { return this.owner.has(this); }
  dispose(): void { this.owner.remove(this); }
}

function captureRule(rule: ConflictRule): ConflictRule {
  const between = Object.freeze([rule.between[0], rule.between[1]] as const);
  const resolve = rule.resolve.strategy === "sequence"
    ? Object.freeze({
        strategy: "sequence" as const,
        order: Object.freeze([rule.resolve.order[0], rule.resolve.order[1]] as const),
      })
    : Object.freeze({ strategy: rule.resolve.strategy });
  return Object.freeze({ store: rule.store, between, resolve });
}

export class ConflictResolver {
  private readonly rules = new Set<ConflictRuleHandle>();

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly fallback: ConflictFallback,
    private readonly assertStoreRegistered: (store: AnyStore) => void,
  ) {}

  add(rule: ConflictRule): ConflictRuleHandle {
    this.dispatcher._assertConfigurationMutable("conflicts.add");
    if (!rule || !Array.isArray(rule.between) || rule.between.length !== 2 || !rule.resolve ||
        !["reject", "skip", "sequence"].includes(rule.resolve.strategy)) {
      throw new TypeError("Invalid conflict rule: expected two registrations and a known strategy");
    }
    const [a, b] = rule.between;
    if (a === b || !a.active || !b.active || a.owner !== this.dispatcher || b.owner !== this.dispatcher) {
      throw new Error("Conflict rule requires two distinct active registrations on this dispatcher");
    }
    this.assertStoreRegistered(rule.store);
    if (rule.resolve.strategy === "sequence") {
      if (!Array.isArray(rule.resolve.order) || rule.resolve.order.length !== 2) throw new TypeError("Sequence order must contain two registrations");
      const [first, second] = rule.resolve.order;
      if (first === second || ![a, b].includes(first) || ![a, b].includes(second)) {
        throw new Error("Sequence order must contain exactly the two 'between' registrations");
      }
    }
    if (this.find(rule.store, a, b)) throw new Error("Duplicate conflict rule for the same Store and pair");
    const handle = new ConflictRuleHandle(captureRule(rule), this);
    this.rules.add(handle);
    return handle;
  }

  /** INTERNAL: determine active state without exposing a mutable flag. */
  has(handle: ConflictRuleHandle): boolean { return this.rules.has(handle); }

  remove(handle: ConflictRuleHandle): void {
    this.dispatcher._assertConfigurationMutable("conflicts.remove");
    this.removeUnchecked(handle);
  }

  private removeUnchecked(handle: ConflictRuleHandle): void {
    if (!this.rules.has(handle)) return;
    this.rules.delete(handle);
  }

  unregister(reg: Registration): void {
    for (const rule of [...this.rules]) {
      if (rule.rule.between.includes(reg)) this.removeUnchecked(rule);
    }
  }

  unregisterStore(store: AnyStore): void {
    for (const rule of [...this.rules]) {
      if (rule.rule.store === store) this.removeUnchecked(rule);
    }
  }

  private find(store: AnyStore, a: Registration, b: Registration): ConflictRuleHandle | undefined {
    for (const handle of this.rules) {
      const rule = handle.rule;
      if (rule.store === store && rule.between.includes(a) && rule.between.includes(b)) return handle;
    }
    return undefined;
  }

  /** Re-evaluation may change a Handler's write set.  Never silently
   * resolve a newly introduced overlap just because we are in sequence mode.
   */
  validateReplayPair(store: AnyStore, earlier: Registration, later: Registration): "sequence" | "skip" {
    const rule = this.find(store, earlier, later)?.rule;
    const policy = rule?.resolve.strategy ?? this.fallback;
    if (policy === "skip") return "skip";
    if (policy !== "sequence" || rule?.resolve.strategy !== "sequence") {
      throw new ConflictError(`Undeclared replay conflict on Store #${store.id} between registrations #${earlier.id} and #${later.id}`);
    }
    if (rule.resolve.order[0] !== earlier || rule.resolve.order[1] !== later) {
      throw new ConflictError(`Replay order contradicts conflict rule for Store #${store.id}`);
    }
    return "sequence";
  }

  /** Plan ALL collisions in a wave before choosing how to publish it.
   * If any pair has no rule, fallback applies.  reject > skip > sequence.
   * Sequence includes every job in the wave and has one eventual atomic commit.
   */
  resolve(jobs: readonly Job[], contexts: readonly Context[]): Resolution {
    const writers = new Map<AnyStore, Registration[]>();
    for (let i = 0; i < contexts.length; i++) {
      for (const store of contexts[i]!._writes().keys()) {
        const regs = writers.get(store) ?? [];
        regs.push(jobs[i]!.reg);
        writers.set(store, regs);
      }
    }

    const edges = new Map<Registration, Set<Registration>>();
    let collided = false;
    let skip = false;
    let reject: string | undefined;

    for (const [store, regs] of writers) {
      for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) {
        collided = true;
        const a = regs[i]!, b = regs[j]!;
        const rule = this.find(store, a, b)?.rule;
        const policy = rule?.resolve.strategy ?? this.fallback;
        if (policy === "reject") {
          reject ??= `Conflicting writes to Store #${store.id} from Handler registrations #${a.id} and #${b.id}`;
        } else if (policy === "skip") {
          skip = true;
        } else if (rule?.resolve.strategy === "sequence") {
          const [first, second] = rule.resolve.order;
          if (!edges.has(first)) edges.set(first, new Set());
          edges.get(first)!.add(second);
        }
      }
    }
    if (reject) throw new ConflictError(reject);
    if (skip) return { strategy: "skip" };
    if (!collided) return { strategy: "parallel" };

    // Stable topological sort.  Non-conflicting jobs preserve the queue order.
    const remaining = [...jobs];
    const ordered: Job[] = [];
    while (remaining.length) {
      const nextIndex = remaining.findIndex(job =>
        !remaining.some(other => edges.get(other.reg)?.has(job.reg))
      );
      if (nextIndex < 0) throw new ConflictError("Cyclic conflict ordering rules in the same wave");
      ordered.push(remaining.splice(nextIndex, 1)[0]!);
    }
    return { strategy: "sequence", jobs: ordered };
  }
}
