/** Stable public surface of the core package. */
export { Dispatcher } from "./dispatcher";
export { Context } from "./context";
export { Handler } from "./handler";
export { Registration } from "./registration";
export { Scope } from "./scope";
export { Store } from "./store";
export { Event } from "./event";
export type { EventOptions, EventOccurrence } from "./event";
export { ConflictResolver, ConflictRuleHandle } from "./reactions/conflicts";
export { ConflictError, FeedbackError, BufferOverflowError, RegistrationSetupError, PostCommitReactionError } from "./errors";
export type { Change, StoreOptions } from "./store";
export type { ReadSnapshot, ReadContext, EffectOptions } from "./context";
export type {
  RecordPolicy, WriteOptions, Delivery, Execution, CommitOutcome, Source,
  RegistrationOptions, DispatcherOptions, BufferOptions, ConflictFallback, ConflictRule,
} from "./types";
