/**
 * Dependency-free SVG rendering for CollatzGraphResult.
 * Graphviz is optional: this renderer works on Windows with Node.js alone.
 *
 * A layered, deterministic layout is used rather than implying that the
 * directed graph is a tree. Back/cross edges and cycles remain visible.
 */
import { isPrimeBigInt, type CollatzGraphResult } from "./collatz-graph";

interface Position { readonly x: number; readonly y: number }

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  });
}

/** Returns a complete standalone SVG document. Does not require Graphviz. */
export function collatzGraphToSvg(graph: CollatzGraphResult): string {
  const out = new Map<bigint, bigint[]>();
  for (const edge of graph.edges) {
    const targets = out.get(edge.from);
    if (targets) targets.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }

  const depths = new Map<bigint, number>([[graph.start, 0]]);
  for (const vertex of graph.vertices) {
    const level = depths.get(vertex) ?? 0;
    for (const to of out.get(vertex) ?? []) {
      if (!depths.has(to)) depths.set(to, level + 1);
    }
  }

  const layers: bigint[][] = [];
  for (const vertex of graph.vertices) {
    const depth = depths.get(vertex) ?? 0;
    (layers[depth] ??= []).push(vertex);
  }

  const labels = graph.vertices.map(String);
  const maxDigits = Math.max(1, ...labels.map(label => label.length));
  const radius = Math.min(57, Math.max(27, 16 + maxDigits * 2.6));
  const xGap = Math.max(175, radius * 2 + 82);
  const yGap = Math.max(86, radius * 2 + 34);
  const maxWidth = Math.max(1, ...layers.map(layer => layer.length));
  const width = Math.ceil(200 + Math.max(0, layers.length - 1) * xGap);
  const height = Math.ceil(160 + Math.max(0, maxWidth - 1) * yGap + 2 * radius);
  const centerY = height / 2 + 26;
  const positions = new Map<bigint, Position>();

  layers.forEach((layer, i) => {
    layer.forEach((vertex, j) => {
      positions.set(vertex, {
        x: Math.round(100 + i * xGap),
        y: Math.round(centerY + (j - (layer.length - 1) / 2) * yGap),
      });
    });
  });

  const svg: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Collatz plus n+1 graph">`,
    `<title>Граф Коллатца + n+1: старт ${graph.start}, вершин ${graph.vertexCount}</title>`,
    `<desc>${graph.vertexCount} уникальных вершин, ${graph.edgeCount} ориентированных рёбер, ${graph.primeCount} простых чисел. Лиловые стрелки — Коллатц, бирюзовые — n+1.</desc>`,
    '<defs>',
    '<marker id="arrow-c" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L0 6 L9 3 Z" fill="#7062d4"/></marker>',
    '<marker id="arrow-i" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L0 6 L9 3 Z" fill="#139d9a"/></marker>',
    '</defs>',
    `<rect width="${width}" height="${height}" fill="#f7f9fe"/>`,
    '<text x="24" y="30" fill="#18243b" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="17">Коллатц + n+1 — ориентированный граф</text>',
    `<text x="24" y="52" fill="#526179" font-family="Segoe UI,Arial,sans-serif" font-size="12">Старт: ${graph.start} · Вершин: ${graph.vertexCount} · Рёбер: ${graph.edgeCount} · Простых: ${graph.primeCount}</text>`,
    '<path d="M24 75 H55" stroke="#7062d4" stroke-width="3" marker-end="url(#arrow-c)"/>',
    '<text x="66" y="79" font-family="Segoe UI,Arial,sans-serif" fill="#526179" font-size="12">Коллатц</text>',
    '<path d="M165 75 H196" stroke="#139d9a" stroke-width="3" marker-end="url(#arrow-i)"/>',
    '<text x="207" y="79" font-family="Segoe UI,Arial,sans-serif" fill="#526179" font-size="12">n + 1</text>',
    '<circle cx="296" cy="72" r="10" fill="#fff3cf" stroke="#d79e34" stroke-width="2"/>',
    '<text x="313" y="79" font-family="Segoe UI,Arial,sans-serif" fill="#526179" font-size="12">простое</text>',
  ];

  for (const edge of graph.edges) {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    if (!source || !target) continue;
    let dx = target.x - source.x;
    let dy = target.y - source.y;
    if (dx === 0 && dy === 0) continue;
    let distance = Math.hypot(dx, dy);
    dx /= distance;
    dy /= distance;
    const x1 = source.x + dx * (radius + 2);
    const y1 = source.y + dy * (radius + 2);
    const x2 = target.x - dx * (radius + 10);
    const y2 = target.y - dy * (radius + 10);
    const offset = edge.kind === "collatz" ? -16 : 16;
    const controlX = (x1 + x2) / 2 - dy * offset;
    const controlY = (y1 + y2) / 2 + dx * offset;
    const marker = edge.kind === "collatz" ? "arrow-c" : "arrow-i";
    const stroke = edge.kind === "collatz" ? "#7062d4" : "#139d9a";
    const label = edge.kind === "collatz" ? "3n+1 / n/2" : "n+1";
    svg.push(`<path data-from="${edge.from}" data-to="${edge.to}" data-kind="${edge.kind}" d="M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="2.1" opacity="0.74" marker-end="url(#${marker})"><title>${edge.from} → ${edge.to} (${label})</title></path>`);
  }

  for (const vertex of graph.vertices) {
    const pos = positions.get(vertex)!;
    const label = vertex.toString();
    const prime = isPrimeBigInt(vertex);
    const root = vertex === graph.start;
    const fill = prime ? "#fff3cf" : root ? "#dce8ff" : "#ffffff";
    const stroke = prime ? "#c89130" : root ? "#477dce" : "#8d9eb9";
    const textSize = Math.max(9, Math.min(14, (radius * 1.6) / Math.max(1, label.length * .62)));
    svg.push(`<g data-node="${label}" data-prime="${prime}" data-root="${root}"><title>${label}${prime ? " — простое" : ""}${root ? " — начальная вершина" : ""}</title>`);
    svg.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${root ? 3 : 2}"/>`);
    if (prime) svg.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius - 5}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`);
    svg.push(`<text x="${pos.x}" y="${pos.y + textSize * .35}" text-anchor="middle" fill="#15233d" font-family="Segoe UI,Arial,sans-serif" font-size="${textSize.toFixed(1)}" font-weight="600">${escapeXml(label)}</text></g>`);
  }
  svg.push('</svg>');
  return svg.join("\n") + "\n";
}
