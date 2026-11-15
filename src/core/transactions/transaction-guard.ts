/** Reentrancy boundary for user callbacks and the atomic commit window. */
export class TransactionGuard {
  private evaluationDepth = 0;
  private committing = false;

  /** Assert that a public administrative action can start.
   * @throws {Error} During evaluation or commit.
   * @sideEffects None.
   */
  assertReady(operation: string): void {
    this.assertNotCommitting(operation);
    if (this.evaluationDepth) {
      throw new Error(`Cannot call Dispatcher.${operation}() while a transaction is being evaluated; use ctx.set() or ctx.effect()`);
    }
  }

  /** Assert that no atomic state publication is underway.
   * @throws {Error} During commit.
   * @sideEffects None.
   */
  assertNotCommitting(operation: string): void {
    if (this.committing) throw new Error(`Cannot call Dispatcher.${operation}() while a Commit is in progress`);
  }

  /** Run a synchronous user callback under the evaluation reentrancy guard.
   * @returns The callback result; exceptions propagate unchanged.
   * @sideEffects Temporarily increments evaluation depth, restored in `finally`.
   */
  evaluate<T>(fn: () => T): T {
    this.evaluationDepth++;
    try { return fn(); }
    finally { this.evaluationDepth--; }
  }

  /** Reserve the commit critical section (not post-commit effects).
   * @throws {Error} If another commit is already publishing.
   * @sideEffects Sets commit lock until `endCommit()`.
   */
  beginCommit(): void {
    this.assertNotCommitting("commit");
    this.committing = true;
  }

  /** Release the lock even when preflight or publication throws.
   * @sideEffects Allows future transactions to commit.
   */
  endCommit(): void { this.committing = false; }
}
