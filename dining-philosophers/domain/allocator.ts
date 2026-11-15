import { appendLog } from "./table";
import type { TableState } from "./types";

export interface AllocationResult {
  readonly state: TableState;
  readonly started: readonly number[];
}

/**
 * Fair reservation waiter. FIFO order wins; a blocked older request reserves
 * the forks it needs so younger neighbors cannot repeatedly cut in line.
 * Non-overlapping philosophers can eat simultaneously.
 */
export function allocateForks(state: TableState): AllocationResult {
  if (state.status !== "running" || state.queue.length === 0) return { state, started: [] };
  const forks = [...state.forks];
  const philosophers = state.philosophers.map(p => ({ ...p }));
  const pending: number[] = [];
  const reserved = new Set<number>();
  const started: number[] = [];
  let result: TableState = state;

  for (const id of state.queue) {
    const index = id - 1;
    const p = philosophers[index];
    if (p?.phase !== "waiting-forks" || p.seat === null) {
      throw new Error(`Invalid waiter P${id}`);
    }
    const left = p.seat;
    const right = (left + 1) % state.count;
    if (forks[left] !== null || forks[right] !== null || reserved.has(left) || reserved.has(right)) {
      pending.push(id);
      reserved.add(left);
      reserved.add(right);
      continue;
    }
    forks[left] = id;
    forks[right] = id;
    const waitingMs = Math.max(0, state.timeMs - (p.waitingSince ?? state.timeMs));
    philosophers[index] = {
      ...p, phase: "eating", dueAt: state.timeMs + state.eatMs,
      waitingSince: null, totalWaitMs: p.totalWaitMs + waitingMs,
      maxWaitMs: Math.max(p.maxWaitMs, waitingMs),
    };
    result = appendLog(result, `P${id} acquired forks ${left + 1} & ${right + 1} and started eating`, "eating", id);
    started.push(id);
  }

  const eatingCount = philosophers.filter(p => p.phase === "eating").length;
  return {
    state: {
      ...result, forks, philosophers, queue: pending,
      maxConcurrentEating: Math.max(state.maxConcurrentEating, eatingCount),
    },
    started,
  };
}
