/** Runtime validation of public options: JavaScript and Frida callers do not get
 * TypeScript's static checks. Reject invalid modes BEFORE subscriptions or work
 * queues can observe them (otherwise a malformed option can break preflight).
 */
import type { ConflictFallback, RegistrationOptions } from "../types";

export function validateConflictFallback(value: unknown): asserts value is ConflictFallback | undefined {
  if (value !== undefined && value !== "reject" && value !== "skip") {
    throw new TypeError("conflictFallback must be 'reject' or 'skip'");
  }
}

export function validateRegistrationOptions(config: RegistrationOptions): void {
  if (config.delivery !== undefined && config.delivery !== "latest" && config.delivery !== "each") {
    throw new TypeError("delivery must be 'latest' or 'each'");
  }
  if (config.execution !== undefined && config.execution !== "inline" && config.execution !== "deferred") {
    throw new TypeError("execution must be 'inline' or 'deferred'");
  }
  if (config.initial !== undefined && typeof config.initial !== "boolean") {
    throw new TypeError("initial must be boolean");
  }
  if (config.on !== undefined) {
    const trigger = config.on as unknown as Record<string, unknown>;
    if (trigger === null || typeof trigger !== "object" || Array.isArray(trigger) ||
        Object.keys(trigger).length !== 1 ||
        !("any" in trigger) && !("all" in trigger)) {
      throw new TypeError("on must contain exactly one of 'any' or 'all'");
    }
    const sources = "any" in trigger ? trigger.any : trigger.all;
    if (!Array.isArray(sources)) throw new TypeError("on.any/on.all must be arrays of Stores");
  }
  if (config.buffer !== undefined) {
    const buffer = config.buffer as unknown as Record<string, unknown>;
    if (!buffer || typeof buffer !== "object" || Array.isArray(buffer)) {
      throw new TypeError("buffer must be an object");
    }
    const overflow = buffer.overflow;
    if (overflow !== undefined && overflow !== "reject" && overflow !== "drop-oldest" && overflow !== "drop-newest") {
      throw new TypeError("buffer.overflow must be 'reject', 'drop-oldest', or 'drop-newest'");
    }
  }
}
