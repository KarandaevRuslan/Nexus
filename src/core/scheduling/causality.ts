/** Causal lineage of reactive work, across deferred scheduler turns.
 * A coalesced job merges its parents into one lineage so latest delivery
 * does not retain an unbounded list of external change IDs.
 */
export class CausalChain {
  private parent?: CausalChain;
  waves = 0;
  stopped = false;
  failure?: unknown;

  constructor(readonly id: number) {}

  root(): CausalChain {
    if (!this.parent) return this;
    this.parent = this.parent.root();
    return this.parent;
  }

  merge(other: CausalChain): CausalChain {
    const a = this.root(), b = other.root();
    if (a === b) return a;
    b.parent = a;
    a.waves = Math.max(a.waves, b.waves);
    a.stopped ||= b.stopped;
    a.failure ??= b.failure;
    return a;
  }
}
