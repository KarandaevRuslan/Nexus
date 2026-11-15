import type { ChangeEvent } from "react";
import type { SimulationConfig, TableState } from "../../domain/types";

interface ControlsProps {
  table: Readonly<TableState>;
  speed: number;
  setSpeed(value: number): void;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setEatMs(value: number): void;
  configure(config: SimulationConfig): void;
}

export function Controls(props: ControlsProps) {
  const { table, speed, setSpeed, start, pause, resume, stop, setEatMs, configure } = props;
  const inactive = table.status === "stopped";
  return (
    <section className="controls-panel">
      <div className="panel-heading"><div><p className="eyebrow">SIMULATION CONTROL</p><h2>Управление</h2></div></div>
      <div className="control-actions">
        <button className="button button-primary" onClick={start} disabled={!inactive}>▶ Запустить</button>
        {table.status === "paused"
          ? <button className="button button-secondary" onClick={resume}>▶ Продолжить</button>
          : <button className="button button-secondary" onClick={pause} disabled={table.status !== "running"}>Ⅱ Пауза</button>}
        <button className="button button-danger" onClick={stop} disabled={inactive}>■ Стоп</button>
      </div>
      <div className="field-row"><label htmlFor="eat-time">Время еды <span>{table.eatMs} мс</span></label>
        <input id="eat-time" type="range" min="100" max="5000" step="100" value={table.eatMs} onChange={(e: ChangeEvent<HTMLInputElement>) => setEatMs(Number(e.target.value))} /></div>
      <div className="field-row"><label htmlFor="speed">Скорость <span>×{speed.toFixed(1)}</span></label>
        <input id="speed" type="range" min="0.5" max="8" step="0.5" value={speed} onChange={(e: ChangeEvent<HTMLInputElement>) => setSpeed(Number(e.target.value))} /></div>
      <div className="field-split">
        <label>Философов <select value={table.count} disabled={!inactive} onChange={(e: ChangeEvent<HTMLSelectElement>) => configure({ count: Number(e.target.value), eatMs: table.eatMs, seed: table.seed })}>
          {Array.from({ length: 8 }, (_, index) => index + 3).map(n => <option key={n} value={n}>{n}</option>)}
        </select></label>
        <label>Seed <input type="number" value={table.seed} disabled={!inactive} onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const seed = Number(e.target.value);
          if (Number.isSafeInteger(seed)) configure({ count: table.count, eatMs: table.eatMs, seed });
        }} /></label>
      </div>
      <div className="config-actions">
        <button className="text-button" onClick={() => {
          window.localStorage.setItem("nexus-philosophers-settings", JSON.stringify({ count: table.count, eatMs: table.eatMs, seed: table.seed, speed }));
        }}>Сохранить настройки</button>
        <button className="text-button" disabled={!inactive} onClick={() => {
          const raw = window.localStorage.getItem("nexus-philosophers-settings");
          if (!raw) return;
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return;
            const data = parsed as Record<string, unknown>;
            const count = Number(data.count), eatMs = Number(data.eatMs), seed = Number(data.seed), nextSpeed = Number(data.speed);
            if (Number.isSafeInteger(count) && count >= 3 && count <= 10 &&
                Number.isSafeInteger(eatMs) && eatMs >= 100 && eatMs <= 10000 && Number.isSafeInteger(seed)) {
              configure({ count, eatMs, seed });
              if (Number.isFinite(nextSpeed)) setSpeed(Math.min(8, Math.max(0.5, nextSpeed)));
            }
          } catch { /* Invalid local storage is not trusted input. */ }
        }}>Загрузить настройки</button>
      </div>
      <p className="control-note">Виртуальные тики; две вилки выдаются одновременно. Пауза останавливает время симуляции.</p>
    </section>
  );
}
