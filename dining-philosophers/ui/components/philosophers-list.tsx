import type { Phase, TableState } from "../../domain/types";

const PHASE_LABELS: Record<Phase, string> = {
  thinking: "Размышляет",
  "waiting-seat": "Ожидает место",
  "waiting-forks": "Ждёт вилки",
  eating: "Ест",
};
const COLORS = ["#f4ad6d", "#65d9bb", "#ad9bfa", "#f17e90", "#78b6f2", "#d9c374", "#db98bd", "#87c7a0", "#dd9f6e", "#a2b8dd"];

export function PhilosophersList({ table }: { table: Readonly<TableState> }) {
  return (
    <section className="people-panel">
      <div className="panel-heading"><div><p className="eyebrow">PARTICIPANTS</p><h2>Философы</h2></div><span className="table-count">{table.count} активных</span></div>
      <div className="philosopher-rows">
        {table.philosophers.map(person => (
          <div className="philosopher-row" key={person.id}>
            <div className="person-avatar" style={{ borderColor: COLORS[(person.id - 1) % COLORS.length], color: COLORS[(person.id - 1) % COLORS.length] }}>{person.id}</div>
            <div className="person-name"><strong>Философ {person.id}</strong><span>Место {person.seat === null ? "—" : person.seat + 1}</span></div>
            <div className={`phase-pill ${person.phase}`}>{PHASE_LABELS[person.phase]}</div>
            <div className="meal-number"><strong>{person.meals}</strong><span>обедов</span></div>
          </div>
        ))}
      </div>
    </section>
  );
}
