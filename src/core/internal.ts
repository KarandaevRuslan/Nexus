/** Non-public scheduler and transaction records. */
import type { Store, Change } from "./store";
import type { Registration } from "./registration";
import type { Context } from "./context";
import type { Event } from "./event";
import type { CausalChain } from "./scheduling/causality";

export type AnyStore = Store<any>;
export type AnyEvent = Event<any>;
export type AnySource = AnyStore | AnyEvent;
export type Emission = Readonly<{ source: AnyEvent; value: unknown }>;
export type Signal = Readonly<{ kind: "emit"; emission: Emission }> | Readonly<{ kind: "request"; reg: Registration }>;
export type AnyChange = Change<any>;
export type Cell = Readonly<{ value: any; version: number }>;
export type Snapshot = Readonly<{ revision: number; cells: ReadonlyMap<AnyStore, Cell> }>;

/** A single commit's compact pre-image: only cells written in that commit. */
export type PreImage = ReadonlyMap<AnyStore, Cell>;

export type CommitFrame = {
  readonly changes: readonly AnyChange[];
  readonly beforeRevision: number;
  readonly preImage: PreImage;
};

export type Job = {
  cause: CausalChain;
  reg: Registration;
  snapshot: Snapshot; // post-commit view
  beforeRevision: number;
  preImage: PreImage;
  changes: ReadonlyMap<AnyStore, AnyChange>;
  emission?: Emission;
};

export type Command = {
  cause: CausalChain;
  /** Optional owning Scope; pending commands are canceled on disposal. */
  owner?: import("./scope").Scope;
  fn: (ctx: Context) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
