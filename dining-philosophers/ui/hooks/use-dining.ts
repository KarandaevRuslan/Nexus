import { useCallback, useEffect, useRef, useState } from "react";
import { makeTable } from "../../domain/table";
import type { SimulationConfig, TableState } from "../../domain/types";
import { createDiningSimulation, type SimulationEngine } from "../../nexus/create-simulation";

const DEFAULT_CONFIG: SimulationConfig = { count: 5, eatMs: 1500, seed: 42 };

export function useDining() {
  const engineRef = useRef<SimulationEngine | null>(null);
  const [table, setTable] = useState<Readonly<TableState>>(() => makeTable(DEFAULT_CONFIG));
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const engine = createDiningSimulation(DEFAULT_CONFIG);
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setTable);
    return () => {
      unsubscribe();
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (table.status !== "running") return;
    const FRAME_MS = 75;
    const handle = window.setInterval(() => {
      try {
        engineRef.current?.tick(Math.round(FRAME_MS * speed));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        engineRef.current?.pause();
      }
    }, FRAME_MS);
    return () => window.clearInterval(handle);
  }, [table.status, speed]);

  const execute = useCallback((callback: (engine: SimulationEngine) => void) => {
    setError(null);
    try {
      const engine = engineRef.current;
      if (engine) callback(engine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const start = useCallback(() => execute(engine => engine.start()), [execute]);
  const pause = useCallback(() => execute(engine => engine.pause()), [execute]);
  const resume = useCallback(() => execute(engine => engine.resume()), [execute]);
  const stop = useCallback(() => execute(engine => engine.stop()), [execute]);
  const clearLogs = useCallback(() => execute(engine => engine.clearLogs()), [execute]);
  const setEatMs = useCallback((eatMs: number) => execute(engine => engine.setEatDuration(eatMs)), [execute]);
  const configure = useCallback((config: SimulationConfig) => execute(engine => engine.configure(config)), [execute]);

  return { table, speed, setSpeed, error, start, pause, resume, stop, clearLogs, setEatMs, configure };
}
