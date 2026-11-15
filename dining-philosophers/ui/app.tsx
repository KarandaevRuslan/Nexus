import { useDining } from "./hooks/use-dining";
import { TableVisual } from "./components/table-visual";
import { PhilosophersList } from "./components/philosophers-list";
import { Controls } from "./components/controls";
import { LogPanel } from "./components/log-panel";

const STATUS_TEXT = { stopped: "Остановлено", running: "Выполняется", paused: "Пауза" } as const;

export function App() {
  const dining = useDining();
  const { table, error } = dining;
  const eating = table.philosophers.filter(p => p.phase === "eating").length;
  const hungry = table.philosophers.filter(p => p.phase.startsWith("waiting")).length;
  const highestWait = Math.max(0, ...table.philosophers.map(p => p.maxWaitMs));
  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="brand"><div className="brand-symbol"><span>∴</span></div><div><span className="brand-title">NEXUS <em>LAB</em></span><span className="brand-subtitle">REACTIVE SYSTEMS / EXPERIMENT 001</span></div></div>
        <span className="version-tag">CORE v0.1.18 <span className="version-bullet">●</span> REACT EDITION</span>
      </header>
      <div className="hero">
        <div><p className="eyebrow">THE CONCURRENCY EXPERIMENT</p><h1>Обедающие <em>философы</em></h1><p className="hero-description">Визуализация конкурентного доступа к ресурсам на одном потоке. Состояние хранит Nexus, события движут симуляцией, React показывает результат.</p></div>
        <div className={`status-display ${table.status}`}><span className="status-led" />{STATUS_TEXT[table.status]}</div>
      </div>
      {error && <div role="alert" className="error-banner">Ошибка симуляции: {error}</div>}
      <div className="metrics-row">
        <div className="metric"><span>ЗАВЕРШЁННЫХ ОБЕДОВ</span><strong>{table.totalMeals}</strong><small>за все время</small></div>
        <div className="metric"><span>СЕЙЧАС ЕДЯТ</span><strong>{eating}<b>/{Math.floor(table.count / 2)}</b></strong><small>макс. без соседства</small></div>
        <div className="metric"><span>В ОЖИДАНИИ</span><strong>{hungry}</strong><small>запросов ресурсов</small></div>
        <div className="metric"><span>ВИРТУАЛЬНОЕ ВРЕМЯ</span><strong>{(table.timeMs / 1000).toFixed(1)}<b>s</b></strong><small>макс. ожидание {(highestWait / 1000).toFixed(2)}s</small></div>
      </div>
      <div className="main-grid">
        <div className="main-column"><TableVisual table={table} /><PhilosophersList table={table} /></div>
        <div className="side-column"><Controls {...dining} /><LogPanel table={table} clearLogs={dining.clearLogs} /></div>
      </div>
      <footer><span>DETERMINISTIC • EVENT-DRIVEN • ATOMIC RESOURCE ALLOCATION</span><span>Исходный Java-проект → Nexus + React</span></footer>
    </main>
  );
}
