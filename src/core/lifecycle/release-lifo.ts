/** Resource teardown helpers shared by Scope cleanup phases. */

/** Dispose owned resources from newest to oldest, stopping at the first failure.
 * @throws {AggregateError} Retains the failed item and earlier ones for a retry.
 * @sideEffects Mutates `items` by popping only successfully released resources.
 */
export function releaseLifo<T>(items: T[], action: (item: T) => void, phase: string): void {
  while (items.length) {
    try {
      action(items[items.length - 1]!);
      items.pop();
    } catch (error) {
      throw new AggregateError([error], `Scope ${phase} cleanup failed; remaining resources retained for retry`);
    }
  }
}
