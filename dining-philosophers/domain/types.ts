/** Domain model: no React, timers, DOM, or Nexus imports. */
export type Phase = "thinking" | "waiting-seat" | "waiting-forks" | "eating";
export type RunStatus = "stopped" | "running" | "paused";

export interface PhilosopherState {
  readonly id: number;
  readonly phase: Phase;
  readonly seat: number | null;
  readonly dueAt: number | null;
  readonly waitingSince: number | null;
  readonly meals: number;
  readonly totalWaitMs: number;
  readonly maxWaitMs: number;
}

export interface TableLog {
  readonly id: number;
  readonly at: number;
  readonly message: string;
  readonly kind: "system" | "seat" | "waiting" | "eating" | "finished";
  readonly philosopherId?: number;
}

export interface TableState {
  readonly status: RunStatus;
  readonly count: number;
  readonly seed: number;
  readonly eatMs: number;
  readonly timeMs: number;
  /** A fork's owner is a philosopher ID, or null when available. */
  readonly forks: readonly (number | null)[];
  /** A seat's occupant is a philosopher ID, or null. */
  readonly seats: readonly (number | null)[];
  readonly philosophers: readonly PhilosopherState[];
  /** FIFO of IDs waiting to acquire both forks atomically. */
  readonly queue: readonly number[];
  readonly totalMeals: number;
  readonly maxConcurrentEating: number;
  readonly logs: readonly TableLog[];
  readonly logSequence: number;
}

export interface SimulationConfig {
  readonly count: number;
  readonly eatMs: number;
  readonly seed: number;
}

export type TableListener = (state: Readonly<TableState>) => void;
