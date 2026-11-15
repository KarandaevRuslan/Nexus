/** Isolated diagnostics: failures in onError must not strand committed work. */
import { DIAGNOSTIC_PREFIX } from "../internal/defaults";

export class ErrorReporter {
  constructor(private readonly onError: (error: unknown) => void) {}

  /** Deliver an error without throwing into scheduling or native hooks.
   * @sideEffects Calls user callback; logs thrown errors and asynchronous rejections.
   */
  report(error: unknown): void {
    try {
      const outcome: unknown = this.onError(error);
      if (outcome !== null &&
          (typeof outcome === "object" || typeof outcome === "function") &&
          typeof (outcome as PromiseLike<void>).then === "function") {
        void Promise.resolve(outcome).catch(reporterError => {
          console.error(`${DIAGNOSTIC_PREFIX} onError rejected`, reporterError);
        });
      }
    } catch (reporterError) {
      console.error(`${DIAGNOSTIC_PREFIX} onError threw`, reporterError);
    }
  }
}
