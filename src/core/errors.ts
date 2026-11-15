export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

/** A lossless subscription is full. The originating state commit is rejected. */
export class BufferOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BufferOverflowError";
  }
}

/** An initial Handler execution failed and the ensuing onDispose() also failed.
 * The deactivated registration remains accessible so ownership and cleanup can
 * be recovered rather than leaving an unreachable Handler in activeHandlers.
 */
import type { Registration } from "./registration";

export class RegistrationSetupError extends AggregateError {
  readonly registration: Registration;
  readonly executionError: unknown;
  readonly cleanupError: unknown;

  constructor(registration: Registration, executionError: unknown, cleanupError: unknown) {
    super([executionError, cleanupError], "Handler initialization and cleanup both failed");
    this.name = "RegistrationSetupError";
    this.registration = registration;
    this.executionError = executionError;
    this.cleanupError = cleanupError;
  }
}

/** The originating inline transaction has committed, but a subsequently
 * triggered synchronous reaction failed. Retrying the originating write is
 * unsafe: inspect committedRevision and cause instead.
 */
export class PostCommitReactionError extends Error {
  constructor(
    readonly committedRevision: number,
    cause: unknown,
  ) {
    super(`Transaction committed at revision ${committedRevision}, but an inline reaction failed`, { cause });
    this.name = "PostCommitReactionError";
  }
}
