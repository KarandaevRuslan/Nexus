import { Dispatcher, type Store, type Scope } from "../../src/core";
import { checkTableInvariants } from "../domain/invariants";
import { changeEatDuration, makeTable, pauseTable, resumeTable, startTable, stopTable, validateConfig } from "../domain/table";
import type { SimulationConfig, TableListener, TableState } from "../domain/types";
import { ClockHandler, type Pulse, type Rebalance } from "./handlers/clock-handler";
import { ForkArbiter, type MealStarted } from "./handlers/fork-arbiter";
import { MealStartedObserver, TableObserver } from "./handlers/observers";

export interface SimulationEngine {
  readonly snapshot: Readonly<TableState>;
  readonly lastError: unknown;
  subscribe(listener: TableListener): () => void;
  subscribeMealStarted(listener: (event: MealStarted) => void): () => void;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  tick(elapsedMs: number): void;
  configure(config: SimulationConfig): void;
  setEatDuration(eatMs: number): void;
  clearLogs(): void;
  dispose(): void;
}

/** Composition root only: rules belong to domain/ and individual handlers/. */
export function createDiningSimulation(config: SimulationConfig = { count: 5, eatMs: 1500, seed: 42 }): SimulationEngine {
  validateConfig(config);
  let lastError: unknown;
  const listeners = new Set<TableListener>();
  const mealListeners = new Set<(event: MealStarted) => void>();
  const dispatcher = new Dispatcher({
    onError(error) { lastError = error; },
    maxInlineWaves: 128,
    maxCausalWaves: 2048,
  });
  const scope: Scope = dispatcher.scope();
  const table: Store<TableState> = scope.store(makeTable(config));
  const pulse = scope.event<Pulse>();
  const rebalance = scope.event<Rebalance>();
  const mealStarted = scope.event<MealStarted>();
  let latest = dispatcher.inline(ctx => ctx.read(table));
  let disposed = false;

  function publish(value: Readonly<TableState>) {
    checkTableInvariants(value);
    latest = value;
    for (const listener of [...listeners]) listener(value);
  }

  scope.register(new ClockHandler(table, pulse, rebalance));
  scope.register(new ForkArbiter(table, rebalance, mealStarted));
  scope.register(new TableObserver(table, publish, scope));
  scope.register(new MealStartedObserver(mealStarted, event => {
    for (const listener of [...mealListeners]) listener(event);
  }, scope));

  function transact(change: (value: Readonly<TableState>) => TableState): void {
    if (disposed) throw new Error("Simulation has been disposed");
    dispatcher.inline(ctx => {
      const previous = ctx.read(table);
      const next = change(previous);
      if (next !== previous) ctx.set(table, next);
    });
  }

  return {
    get snapshot() { return latest; },
    get lastError() { return lastError; },
    subscribe(listener) {
      if (disposed) throw new Error("Simulation has been disposed");
      listeners.add(listener);
      listener(latest);
      return () => { listeners.delete(listener); };
    },
    subscribeMealStarted(listener) {
      if (disposed) throw new Error("Simulation has been disposed");
      mealListeners.add(listener);
      return () => { mealListeners.delete(listener); };
    },
    start() { transact(startTable); },
    pause() { transact(pauseTable); },
    resume() { transact(resumeTable); },
    stop() { transact(stopTable); },
    tick(elapsedMs) {
      if (disposed) throw new Error("Simulation has been disposed");
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 1 || elapsedMs > 100_000) {
        throw new RangeError("elapsedMs must be an integer from 1 to 100000");
      }
      if (latest.status !== "running") return;
      dispatcher.inline(ctx => ctx.emit(pulse, { elapsedMs }));
    },
    configure(nextConfig) {
      validateConfig(nextConfig);
      transact(old => {
        if (old.status !== "stopped") throw new Error("Stop before changing count or seed");
        return makeTable(nextConfig);
      });
    },
    setEatDuration(eatMs) { transact(old => changeEatDuration(old, eatMs)); },
    clearLogs() { transact(old => ({ ...old, logs: [] })); },
    dispose() {
      if (disposed) return;
      disposed = true;
      scope.dispose();
      listeners.clear();
      mealListeners.clear();
    },
  };
}
