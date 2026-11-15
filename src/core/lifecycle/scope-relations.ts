/** Scope dependency graph, distinct from the resources it owns. */
import type { Scope } from "../scope";

/** Weak ownership index: mutation is not exposed as a Scope public property. */
const relationIndex = new WeakMap<Scope, ScopeRelations>();

/** Return internal relations without making the graph writable via Scope handles.
 * @throws {Error} For objects that are not initialized Scopes.
 * @sideEffects None.
 */
export function relationsOf(scope: Scope): ScopeRelations {
  const relations = relationIndex.get(scope);
  if (!relations) throw new Error("Unknown Scope");
  return relations;
}

/** Tracks ownership and borrowing edges without starting resource cleanup. */
export class ScopeRelations {
  readonly ownedChildren: Scope[] = [];
  private parent?: Scope;
  private readonly owners = new Set<Scope>();
  private readonly dependents = new Set<Scope>();

  constructor(private readonly scope: Scope) { relationIndex.set(scope, this); }

  /** Record an owned child. The caller first creates the borrowing dependency.
   * @sideEffects Adds an ownership edge that is torn down in reverse creation order.
   */
  addChild(child: Scope): void {
    relationsOf(child).parent = this.scope;
    this.ownedChildren.push(child);
  }

  /** Declare an explicit resource borrowing edge and reject cycles.
   * @throws {Error} For inactive owners, self-dependency or cycles.
   * @sideEffects Adds the reciprocal owner/dependent entries.
   */
  dependsOn(owner: Scope): void {
    if (owner === this.scope || !owner.active) {
      throw new Error("Cannot depend on self or inactive Scope");
    }
    if (relationsOf(owner).reaches(this.scope)) {
      throw new Error("Cyclic Scope lifetime dependency");
    }
    this.owners.add(owner);
    relationsOf(owner).dependents.add(this.scope);
  }

  /** Depth-first reachability to block cycles; repeated owners are harmless.
   * @returns Whether following ownership dependencies can reach `other`.
   * @sideEffects Adds to the transient `visited` Set only.
   */
  private reaches(other: Scope, visited = new Set<Scope>()): boolean {
    if (this.scope === other) return true;
    if (visited.has(this.scope)) return false;
    visited.add(this.scope);
    for (const owner of this.owners) {
      if (relationsOf(owner).reaches(other, visited)) return true;
    }
    return false;
  }

  /** Borrowed dependent Scopes block teardown, but owned children do not.
   * @throws {Error} While a non-owned dependent still borrows resources.
   * @sideEffects None.
   */
  assertCanDispose(): void {
    const count = [...this.dependents].filter(scope => !this.ownedChildren.includes(scope)).length;
    if (count > 0) {
      throw new Error(`Cannot dispose Scope: ${count} dependent Scope(s) still own resources`);
    }
  }

  /** Release owned children in strict reverse order, retaining failures for retry.
   * @throws {AggregateError} On a child cleanup failure.
   * @sideEffects Calls child.dispose(), removing each successfully released ownership edge.
   */
  disposeChildren(): void {
    while (this.ownedChildren.length) {
      const child = this.ownedChildren[this.ownedChildren.length - 1]!;
      try {
        child.dispose();
        // Child normally unlinks itself, but clean up defensively if needed.
        this.removeChild(child);
      } catch (error) {
        throw new AggregateError([error], "Scope child cleanup failed; owned children and parent resources retained for retry");
      }
    }
  }

  /** Detach a successfully disposed scope from its owners and parent.
   * @sideEffects Removes both sides of all lifetime edges.
   */
  release(): void {
    for (const owner of this.owners) relationsOf(owner).dependents.delete(this.scope);
    this.owners.clear();
    if (this.parent) {
      relationsOf(this.parent).removeChild(this.scope);
      this.parent = undefined;
    }
  }

  private removeChild(child: Scope): void {
    const index = this.ownedChildren.indexOf(child);
    if (index !== -1) this.ownedChildren.splice(index, 1);
  }
}
