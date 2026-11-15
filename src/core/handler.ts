import type { Context, ReadContext } from "./context";
import type { RegistrationOptions, Trigger } from "./types";

/** User behavior, independent of a particular registration.
 * Defaults are captured once, at construction; register() may override them.
 */
export abstract class Handler {
  readonly options: Readonly<RegistrationOptions>;

  constructor(options: RegistrationOptions = {}) {
    // Do not let subsequent mutation of a caller-owned options/array silently
    // change the registration policy (or the public Handler defaults).
    const on: Trigger | undefined = options.on
      ? "any" in options.on
        ? Object.freeze({ any: Object.freeze([...options.on.any]) })
        : Object.freeze({ all: Object.freeze([...options.on.all]) })
      : undefined;
    this.options = Object.freeze({
      ...options,
      ...(on ? { on } : {}),
      ...(options.buffer ? { buffer: Object.freeze({ ...options.buffer }) } : {}),
    });
  }

  /** Test whether a job should execute; may inspect only read-only Context data.
   * @returns Whether `run()` should be invoked.
   * @sideEffects Must have no externally visible side effects; called synchronously.
   */
  when(_ctx: ReadContext): boolean { return true; }

  /** Stage one reaction's writes, requests and post-commit effects.
   * @sideEffects Must not perform irreversible external actions: use ctx.effect() instead.
   */
  abstract run(ctx: Context): void;
  /** Optional synchronous cleanup after this registration has been deactivated.
   * @sideEffects May release external resources; failures are retryable.
   */
  onDispose(): void { /* Optional lifecycle hook. */ }
}
