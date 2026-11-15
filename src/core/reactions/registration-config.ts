/** Convert public Handler options into a validated, immutable registration plan. */
import { Event } from "../event";
import type { AnySource } from "../internal";
import type { Handler } from "../handler";
import type { BufferOptions, Delivery, Execution, RegistrationOptions } from "../types";
import { validateRegistrationOptions } from "./validate-options";
import { DEFAULT_LIMITS } from "../internal/defaults";

/** Validated settings used to create exactly one Registration. */
export interface RegistrationPlan {
  readonly sources: readonly AnySource[];
  readonly mode: "any" | "all";
  readonly delivery: Delivery;
  readonly execution: Execution;
  readonly buffer: Readonly<Required<BufferOptions>>;
  readonly initial: boolean;
}

/** Merge constructor options with call-site overrides and validate combinations.
 * @returns An independent plan; never mutates Handler or supplied options.
 * @throws {TypeError | RangeError | Error} On invalid modes, sources or capacity.
 * @sideEffects None.
 */
export function planRegistration(handler: Handler, options: RegistrationOptions): RegistrationPlan {
  const config: RegistrationOptions = { ...handler.options, ...options };
  // A latest-delivery override must not retain the Handler's each-only buffer.
  if (options.delivery === "latest" && options.buffer === undefined) delete config.buffer;
  validateRegistrationOptions(config);

  const mode = config.on && "all" in config.on ? "all" : "any";
  const sources = config.on ? [...("any" in config.on ? config.on.any : config.on.all)] : [];
  if (config.on && (sources.length === 0 || new Set(sources).size !== sources.length)) {
    throw new Error("on must contain at least one unique Store");
  }
  const delivery = config.delivery ?? "latest";
  const execution = config.execution ?? "deferred";
  if (mode === "all" && sources.some(source => source instanceof Event)) {
    throw new Error("on.all only supports Stores; use on.any for Events");
  }
  if (delivery === "each" && mode === "all") {
    throw new Error("delivery:'each' with on.all is ambiguous; use latest or separate handlers");
  }
  if (config.buffer && delivery !== "each") {
    throw new Error("buffer is only applicable to delivery:'each'");
  }
  const buffer: Required<BufferOptions> = {
    capacity: config.buffer?.capacity ?? DEFAULT_LIMITS.eventBufferCapacity,
    overflow: config.buffer?.overflow ?? "reject",
  };
  positiveBufferCapacity(buffer.capacity);
  return { sources, mode, delivery, execution, buffer, initial: config.initial ?? false };
}

/** Reject unbounded or non-integer queue sizes before a Registration is created.
 * @sideEffects None.
 */
function positiveBufferCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("buffer.capacity must be a positive integer");
  }
}
