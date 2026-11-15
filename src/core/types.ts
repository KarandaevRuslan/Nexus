/** Public contracts shared by the execution engine. */
export type RecordPolicy = "changed" | "always";
export interface WriteOptions { record?: RecordPolicy }
export type Delivery = "latest" | "each";
/** Event buffer applies only to delivery:'each'. The default is bounded and lossless. */
export interface BufferOptions {
  capacity: number;
  overflow?: "reject" | "drop-oldest" | "drop-newest";
}
export type Execution = "inline" | "deferred";

export type CommitOutcome = {
  readonly revision: number;
  readonly changes: number;
};

export type Source = import("./store").Store<any> | import("./event").Event<any>;
export type Trigger = { any: readonly Source[] } | {
  /** on.all is state-only: correlating unrelated event occurrences is ambiguous. */
  all: readonly import("./store").Store<any>[];
};

export interface RegistrationOptions {
  on?: Trigger;
  delivery?: Delivery;
  execution?: Execution;
  initial?: boolean;
  buffer?: BufferOptions;
}

/** Fallback for collisions without an explicit pair-and-Store rule. */
export type ConflictFallback = "reject" | "skip";

/** Rules refer to concrete registrations (not Handler class identities). */
export type ConflictRule = {
  readonly store: import("./store").Store<any>;
  readonly between: readonly [import("./registration").Registration, import("./registration").Registration];
  readonly resolve:
    | { readonly strategy: "reject" | "skip" }
    | { readonly strategy: "sequence"; readonly order: readonly [import("./registration").Registration, import("./registration").Registration] };
};

export interface DispatcherOptions {
  conflictFallback?: ConflictFallback;
  maxInlineWaves?: number;
  /** Maximum synchronous nesting of dispatcher.inline(), including effect reentry. */
  maxInlineDepth?: number;
  maxWavesPerTurn?: number;
  /** Maximum consecutive queued commands before one deferred wave gets a turn.
   * This quota persists across scheduler turns to prevent deferred starvation.
   */
  maxCommandsBeforeDeferred?: number;
  /** Maximum reactive waves in one causal lineage, even across scheduler turns. */
  maxCausalWaves?: number;
  /** Diagnostics are fire-and-forget. Async rejection is logged as a fallback. */
  onError?: (error: unknown) => void;
}
