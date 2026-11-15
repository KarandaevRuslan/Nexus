import type { TableState } from "../../domain/types";

const COLORS = ["#f4ad6d", "#65d9bb", "#ad9bfa", "#f17e90", "#78b6f2", "#d9c374", "#db98bd", "#87c7a0", "#dd9f6e", "#a2b8dd"];

const cx = 350, cy = 260;
const polar = (radius: number, angle: number) => ({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
const angleFor = (index: number, total: number) => -Math.PI / 2 + index * 2 * Math.PI / total;

export function TableVisual({ table }: { table: Readonly<TableState> }) {
  const n = table.count;
  const atTable = table.philosophers.filter(p => p.seat !== null).length;
  return (
    <section className="table-panel" aria-label="Положение философов за столом">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LIVE RESOURCE MAP</p>
          <h2>Стол и ресурсы</h2>
        </div>
        <span className="table-count">{atTable} / {n} мест занято</span>
      </div>
      <svg className="table-svg" viewBox="0 0 700 595" role="img" aria-label="Круглый стол, свободные и занятые вилки, философы и их места">
        <defs>
          <radialGradient id="tableSurface"><stop offset="0" stopColor="#33494b" /><stop offset="1" stopColor="#1b3032" /></radialGradient>
          <linearGradient id="tableRim" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#89988a" /><stop offset=".55" stopColor="#3a5d56" /><stop offset="1" stopColor="#17282b" /></linearGradient>
          <filter id="softShadow"><feDropShadow dx="0" dy="12" stdDeviation="15" floodColor="#000" floodOpacity=".45" /></filter>
        </defs>
        <circle cx={cx} cy={cy} r="220" fill="url(#tableRim)" stroke="#6e8880" strokeWidth="1" filter="url(#softShadow)" />
        <circle cx={cx} cy={cy} r="208" fill="url(#tableSurface)" stroke="#47615d" strokeWidth="2" />
        <circle cx={cx} cy={cy} r="107" fill="#1b2c2e" stroke="#3f5754" strokeDasharray="3 7" strokeWidth="1.5" />
        <text x={cx} y={cy - 20} className="table-center-small" textAnchor="middle">NEXUS</text>
        <text x={cx} y={cy + 18} className="table-center-main" textAnchor="middle">PHILOSOPHERS</text>
        <text x={cx} y={cy + 47} className="table-center-sub" textAnchor="middle">ATOMIC FORK ALLOCATION</text>
        {table.seats.map((owner, i) => {
          const angle = angleFor(i + .5, n);
          const p = polar(158, angle);
          const person = owner === null ? null : table.philosophers[owner - 1];
          const eating = person?.phase === "eating";
          const tint = person ? COLORS[(person.id - 1) % COLORS.length] : "#5c837a";
          return (
            <g key={`seat-${i}`}>
              <title>{`Место ${i + 1}: ${owner === null ? "свободно" : `философ ${owner}, ${person?.phase === "eating" ? "ест" : "ждёт вилки"}`}`}</title>
              <circle cx={p.x} cy={p.y} r="38" fill="#0f2225" stroke={eating ? tint : "#526965"} strokeWidth={eating ? 5 : 2.5} />
              <circle cx={p.x} cy={p.y} r="31" fill={owner === null ? "#203736" : `${tint}1b`} stroke={owner === null ? "#47625b" : tint} strokeWidth="1" strokeDasharray={eating ? undefined : "3 5"} />
              <text x={p.x} y={p.y + (owner ? 7 : 4)} textAnchor="middle" fontSize={owner ? 23 : 12} fontWeight="700" fill={owner ? tint : "#75918a"}>
                {owner === null ? `S${i + 1}` : `P${owner}`}
              </text>
              {eating && <circle cx={p.x + 27} cy={p.y - 27} r="7" fill="#6cdbb5" className="eating-beacon" />}
            </g>
          );
        })}
        {table.forks.map((owner, i) => {
          const angle = angleFor(i, n);
          const pos = polar(181, angle);
          const free = owner === null;
          const dirX = Math.cos(angle + Math.PI / 2);
          const dirY = Math.sin(angle + Math.PI / 2);
          const color = free ? "#7ed8aa" : COLORS[(owner - 1) % COLORS.length];
          return (
            <g key={`fork-${i}`}>
              <title>{`Вилка ${i + 1}: ${free ? "свободна" : `занята философом ${owner}`}`}</title>
              <line x1={pos.x - dirX * 20} y1={pos.y - dirY * 20} x2={pos.x + dirX * 20} y2={pos.y + dirY * 20}
                stroke="#0f1d1f" strokeWidth="11" strokeLinecap="round" />
              <line x1={pos.x - dirX * 20} y1={pos.y - dirY * 20} x2={pos.x + dirX * 20} y2={pos.y + dirY * 20}
                stroke={color} strokeWidth="5" strokeLinecap="round" className={free ? "" : "fork-in-use"} />
              <text x={pos.x + Math.cos(angle) * 22} y={pos.y + Math.sin(angle) * 22 + 4} fontSize="10" fontWeight="700" textAnchor="middle" fill={color}>F{i + 1}</text>
            </g>
          );
        })}
        <text x={cx} y={555} textAnchor="middle" className="floor-hint">ФИЛОСОФЫ БЕЗ МЕСТА · THINKING / WAITING</text>
        {table.philosophers.filter(p => p.seat === null).map((p, index, all) => {
          const gap = Math.min(80, 630 / Math.max(1, all.length));
          const x = cx - ((all.length - 1) * gap) / 2 + index * gap;
          const color = COLORS[(p.id - 1) % COLORS.length];
          return <g key={`standing-${p.id}`}>
            <circle cx={x} cy={511} r="21" fill="#192e30" stroke={color} strokeWidth="2" />
            <text x={x} y={517} textAnchor="middle" fontSize="15" fontWeight="700" fill={color}>P{p.id}</text>
          </g>;
        })}
      </svg>
      <div className="legend" aria-label="Условные обозначения">
        <span><i className="legend-mark free" />Свободная вилка</span>
        <span><i className="legend-mark held" />Занятая вилка</span>
        <span><i className="legend-mark eating" />Ест</span>
        <span><i className="legend-mark waiting" />Ждёт</span>
      </div>
    </section>
  );
}
