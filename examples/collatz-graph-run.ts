import { collatzGraph, createCollatzGraphExplorer, type CollatzGraphResult } from "./collatz-graph";
import { saveCollatzGraphFiles } from "./collatz-graph-files";

// Node entrypoint; avoid @types/node in this portable example.
declare const process: { readonly argv: string[] };

function printGraph(graph: CollatzGraphResult, detailed = false): void {
  console.log(`start=${graph.start}, limit=${graph.limit}`);
  console.log(`vertices=${graph.vertexCount}, edges=${graph.edgeCount}, primes=${graph.primeCount}, omitted=${graph.omittedTransitions}`);
  console.log("vertices:", graph.vertices.map(String).join(", "));
  if (detailed) {
    console.log("edges:");
    for (const edge of graph.edges) {
      console.log(`  ${edge.from} -> ${edge.to} (${edge.kind})`);
    }
  }
  const files = saveCollatzGraphFiles(graph);
  console.log(`Graph DOT: ${files.dot}`);
  console.log(`Graph SVG: ${files.svg} (${files.renderer === "graphviz" ? "Graphviz" : "встроенный рендерер"})`);
  if (files.png) console.log(`Graph PNG: ${files.png}`);
  console.log("Открой SVG в браузере; PNG создаётся автоматически при установленном Graphviz.");
  console.log();
}

const args = process.argv.slice(2);
if (args.length > 0) {
  if (args.length !== 2) {
    throw new Error("Usage: npm run collatz-graph-demo -- <start> <maxVertices>");
  }
  const start = BigInt(args[0]!);
  const limit = Number(args[1]!);
  printGraph(collatzGraph(start, limit), true);
} else {
  // Preserve the original multiple-invocation demo, now saving graphs for all
  // requested pairs (duplicates safely overwrite the same deterministic path).
  const explorer = createCollatzGraphExplorer(50);
  try {
    for (const [start, limit] of [[6, 10], [7, 20], [1, 10], [6, 10]] as const) {
      printGraph(explorer.explore(start, limit));
    }
  } finally { explorer.dispose(); }
}
