import type { TableState } from "../../domain/types";

function formatTime(ms: number): string { return (ms / 1000).toFixed(2).padStart(6, "0"); }

export function LogPanel({ table, clearLogs }: { table: Readonly<TableState>; clearLogs: () => void }) {
  return (
    <section className="log-panel">
      <div className="panel-heading"><div><p className="eyebrow">EVENT STREAM</p><h2>Журнал событий</h2></div>
        <button className="text-button" onClick={clearLogs} disabled={table.logs.length === 0}>Очистить</button>
      </div>
      <div className="log-feed" role="log" aria-label="Журнал симуляции">
        {table.logs.length === 0 && <p className="empty-log">События появятся после запуска.</p>}
        {[...table.logs].reverse().map(entry => (
          <div className={`log-item ${entry.kind}`} key={entry.id}>
            <span className="log-time">{formatTime(entry.at)}s</span>
            <span className="log-dot" />
            <span className="log-text">{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
