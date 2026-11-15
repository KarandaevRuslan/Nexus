import {
  collatzGraph, collatzGraphToDot, createCollatzGraphExplorer,
  isPrimeBigInt, type CollatzGraphResult,
} from "../examples/collatz-graph";
import { eq, ok, throws } from "./helpers";

// Independent imperative oracle: no Nexus, no Event and no Store.
function smallPrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (let d = 2n; d * d <= n; d++) if (n % d === 0n) return false;
  return true;
}
function reference(start: bigint, limit: number) {
  const vertices: bigint[] = [start];
  const membership = new Set<bigint>([start]);
  const edges: string[] = [];
  let omitted = 0;
  for (let i = 0; i < vertices.length; ++i) {
    const n = vertices[i]!;
    const children: Array<[string, bigint]> = [
      ["collatz", n % 2n === 0n ? n / 2n : n * 3n + 1n],
      ["increment", n + 1n],
    ];
    for (const [kind, target] of children) {
      if (!membership.has(target)) {
        if (vertices.length === limit) { ++omitted; continue; }
        vertices.push(target);
        membership.add(target);
      }
      edges.push(`${n}:${target}:${kind}`);
    }
  }
  return {
    vertices: vertices.map(String).join(","),
    edges: edges.join(","),
    primes: vertices.filter(smallPrime).length,
    omitted,
  };
}

function compareToReference(result: CollatzGraphResult): void {
  const expected = reference(result.start, result.limit);
  eq(result.vertices.map(String).join(","), expected.vertices, "BFS order");
  eq(result.edges.map(e => `${e.from}:${e.to}:${e.kind}`).join(","), expected.edges, "edge list");
  eq(result.primeCount, expected.primes, "prime count");
  eq(result.omittedTransitions, expected.omitted, "omitted transitions");
  eq(result.vertexCount, result.vertices.length);
  eq(result.edgeCount, result.edges.length);
  eq(result.truncated, result.omittedTransitions > 0);
  ok(result.vertexCount <= result.limit);
  ok(new Set(result.vertices).size === result.vertexCount, "vertices are unique");
  const known = new Set(result.vertices);
  for (const edge of result.edges) {
    ok(known.has(edge.from) && known.has(edge.to), "edge endpoints must exist");
  }
}

export const collatzGraphCases: Array<[string, () => void]> = [
  ["Collatz graph (6,10) exact expected node order, counts and truncation", () => {
    const result = collatzGraph(6, 10);
    eq(result.vertices.map(String).join(","), "6,3,7,10,4,22,8,5,11,2");
    eq(result.vertexCount, 10);
    eq(result.edgeCount, 14);
    eq(result.primeCount, 5);
    eq(result.omittedTransitions, 6);
    eq(result.truncated, true);
    compareToReference(result);
  }],
  ["Collatz graph expands one through BOTH 1 -> 4 and 1 -> 2", () => {
    const result = collatzGraph(1, 10);
    eq(result.vertexCount, 10);
    eq(result.vertices.map(String).join(","), "1,4,2,5,3,16,6,10,8,17");
    eq(result.edgeCount, 15);
    eq(result.primeCount, 4);
    eq(result.omittedTransitions, 5);
    ok(result.edges.some(e => e.from === 1n && e.to === 4n && e.kind === "collatz"));
    ok(result.edges.some(e => e.from === 1n && e.to === 2n && e.kind === "increment"));
    ok(result.edges.some(e => e.from === 2n && e.to === 1n && e.kind === "collatz"));
    compareToReference(result);
  }],
  ["Graph can contain the closed cycle 1 -> 4 -> 2 -> 1", () => {
    const result = collatzGraph(1, 3);
    eq(result.vertices.map(String).join(","), "1,4,2");
    eq(result.edgeCount, 4);
    eq(result.primeCount, 1);
    const collatzEdges = result.edges.filter(e => e.kind === "collatz");
    eq(collatzEdges.map(e => `${e.from}->${e.to}`).join(","), "1->4,4->2,2->1");
    compareToReference(result);
  }],
  ["Vertex limit applies to 1 -> 4 before 1 -> 2", () => {
    const result = collatzGraph(1, 2);
    eq(result.vertices.map(String).join(","), "1,4");
    eq(result.edgeCount, 1);
    eq(result.omittedTransitions, 3);
    ok(result.edges.some(e => e.from === 1n && e.to === 4n && e.kind === "collatz"));
    ok(!result.edges.some(e => e.from === 1n && e.to === 2n));
    compareToReference(result);
  }],
  ["Limit 1 includes just the root and never creates external edge targets", () => {
    for (const start of [1, 2, 3, 6, 19, 27]) {
      const result = collatzGraph(start, 1);
      eq(result.vertexCount, 1);
      eq(result.edgeCount, 0);
      eq(result.vertices[0], BigInt(start));
      eq(result.primeCount, smallPrime(BigInt(start)) ? 1 : 0);
      eq(result.omittedTransitions, 2);
    }
  }],
  ["Capacity is a vertex bound, not a Collatz-step or edge bound", () => {
    const result = collatzGraph(7, 20);
    eq(result.vertexCount, 20);
    eq(result.edgeCount, 25);
    eq(result.primeCount, 8);
    eq(result.omittedTransitions, 15);
    ok(result.edgeCount > result.vertexCount);
    compareToReference(result);
  }],
  ["Cross-check 100 runs against an independent reference graph builder", () => {
    const explorer = createCollatzGraphExplorer(40);
    try {
      for (let n = 1; n <= 20; n++) {
        for (const limit of [1, 2, 3, 6, 15]) {
          compareToReference(explorer.explore(n, limit));
        }
      }
    } finally { explorer.dispose(); }
  }],
  ["Reusable explorer resets visited set, edge counts and event generation", () => {
    const explorer = createCollatzGraphExplorer(30);
    try {
      const a = explorer.explore(6, 12);
      const b = explorer.explore(7, 30);
      const c = explorer.explore(6, 12);
      const d = explorer.explore(1, 1);
      eq(a.vertices.map(String).join(), c.vertices.map(String).join());
      eq(a.edges.length, c.edges.length);
      eq(b.vertexCount, 30);
      eq(d.vertexCount, 1);
      // Earlier results are immutable copies, not mutable views into the store.
      eq(a.vertexCount, 12);
      eq(a.vertices[0], 6n);
      compareToReference(a);
      compareToReference(b);
      compareToReference(c);
    } finally { explorer.dispose(); }
  }],
  ["Result containers and edge records are immutable across later calls", () => {
    const explorer = createCollatzGraphExplorer(12);
    try {
      const a = explorer.explore(6, 10);
      ok(Object.isFrozen(a));
      ok(Object.isFrozen(a.vertices));
      ok(Object.isFrozen(a.edges));
      ok(a.edges.every(e => Object.isFrozen(e)));
      explorer.explore(1, 12);
      eq(a.vertices.map(String).join(), "6,3,7,10,4,22,8,5,11,2");
    } finally { explorer.dispose(); }
  }],
  ["BigInt inputs preserve precision beyond MAX_SAFE_INTEGER", () => {
    const large = 1n << 60n;
    const graph = collatzGraph(large, 3);
    eq(graph.vertices[0], large);
    eq(graph.vertices[1], large / 2n);
    eq(graph.vertices[2], large + 1n);
    ok(graph.edges.some(e => e.from === large && e.to === large + 1n));
  }],
  ["Deterministic primality function recognizes primes and pseudoprimes", () => {
    for (const n of [2n, 3n, 5n, 7n, 97n, 999983n, 2305843009213693951n]) {
      ok(isPrimeBigInt(n), `${n} must be prime`);
    }
    for (const n of [0n, 1n, 4n, 9n, 25n, 561n, 1105n, 341550071728321n]) {
      ok(!isPrimeBigInt(n), `${n} must be composite / nonprime`);
    }
  }],
  ["Every graph edge uses the correct Collatz or increment relation", () => {
    const graph = collatzGraph(27, 100);
    for (const edge of graph.edges) {
      if (edge.kind === "increment") eq(edge.to, edge.from + 1n);
      else {
        eq(edge.to, edge.from % 2n === 0n ? edge.from / 2n : 3n * edge.from + 1n);
      }
    }
    compareToReference(graph);
  }],
  ["Input and budget validation rejects invalid arguments", () => {
    for (const n of [0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      throws(() => collatzGraph(n, 2), RangeError);
    }
    throws(() => collatzGraph(0n, 2), RangeError);
    for (const count of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      throws(() => collatzGraph(1, count), RangeError);
    }
    const explorer = createCollatzGraphExplorer(3);
    try { throws(() => explorer.explore(2, 4), RangeError); }
    finally { explorer.dispose(); }
  }],
  ["Disposal prevents new work but does not mutate earlier returned results", () => {
    const explorer = createCollatzGraphExplorer(10);
    const result = explorer.explore(6, 10);
    explorer.dispose();
    throws(() => explorer.explore(3, 5));
    eq(result.vertices[0], 6n);
    eq(result.primeCount, 5);
  }],
  ["Graphviz DOT contains every node, both kinds of edges and prime styling", () => {
    const result = collatzGraph(6, 10);
    const dot = collatzGraphToDot(result);
    ok(dot.startsWith("digraph CollatzSuccessor {"));
    ok(dot.includes('"3" [label="3", shape=doublecircle]'));
    ok(dot.includes('"6" -> "3" [label="3n+1 / n÷2"]'));
    ok(dot.includes('"6" -> "7" [label="+1"]'));
    eq(dot.split("\n").length, result.vertexCount + result.edgeCount + 3);
    const fromOne = collatzGraphToDot(collatzGraph(1, 3));
    ok(fromOne.includes('"1" -> "4" [label="3n+1 / n÷2"]'));
    ok(fromOne.includes('"1" -> "2" [label="+1"]'));
  }],
];
