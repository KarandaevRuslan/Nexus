/** Internal defaults shared by configuration, queueing and scheduling. */
export const DEFAULT_LIMITS = Object.freeze({
  inlineWaves: 32,
  inlineDepth: 32,
  wavesPerTurn: 32,
  commandsBeforeDeferred: 16,
  causalWaves: 256,
  manualFlushWaves: 10_000,
  eventBufferCapacity: 1_024,
  schedulerDelayMs: 0,
});

export const DIAGNOSTIC_PREFIX = "[Nexus]";

/** Validate a runtime budget before mutating any scheduler state.
 * @throws {RangeError} If `value` is not a positive safe integer.
 * @sideEffects None.
 */
export function positiveBudget(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
