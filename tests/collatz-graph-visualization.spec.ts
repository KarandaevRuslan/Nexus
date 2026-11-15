import { collatzGraph } from "../examples/collatz-graph";
import { collatzGraphToSvg } from "../examples/collatz-graph-svg";
import { saveCollatzGraphFiles } from "../examples/collatz-graph-files";
import { eq, ok } from "./helpers";

declare function require(name: string): unknown;
interface Fs {
  mkdtempSync(prefix: string): string;
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  existsSync(path: string): boolean;
}
interface Os { tmpdir(): string }
interface Path { join(...parts: string[]): string; basename(path: string): string }
const fs = require("node:fs") as Fs;
const os = require("node:os") as Os;
const path = require("node:path") as Path;

export const collatzVisualizationCases: Array<[string, () => void]> = [
  ["Visualization: standalone SVG contains all 10 vertices and 15 directed edges", () => {
    const graph = collatzGraph(1, 10);
    const svg = collatzGraphToSvg(graph);
    ok(svg.startsWith('<?xml version="1.0"'));
    ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
    eq((svg.match(/data-node="/g) ?? []).length, 10);
    eq((svg.match(/data-from="/g) ?? []).length, 15);
    eq((svg.match(/data-prime="true"/g) ?? []).length, 4);
    ok(svg.includes('data-from="1" data-to="4" data-kind="collatz"'));
    ok(svg.includes('data-from="2" data-to="1" data-kind="collatz"'));
    ok(svg.includes('data-from="1" data-to="2" data-kind="increment"'));
  }],
  ["Visualization: SVG is deterministic and does not mutate the graph", () => {
    const graph = collatzGraph(6, 10);
    const first = collatzGraphToSvg(graph);
    const second = collatzGraphToSvg(graph);
    eq(first, second);
    eq(graph.vertexCount, 10);
    eq(graph.edgeCount, 14);
    eq(graph.primeCount, 5);
    ok(Object.isFrozen(graph.vertices));
  }],
  ["Visualization: fallback SVG and DOT files work without Graphviz", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-collatz-visual-"));
    try {
      const graph = collatzGraph(1, 10);
      const result = saveCollatzGraphFiles(graph, { outputDir: tmp, useGraphviz: false });
      eq(result.renderer, "builtin");
      eq(result.png, undefined);
      ok(fs.existsSync(result.dot));
      ok(fs.existsSync(result.svg));
      ok(fs.readFileSync(result.svg, "utf8").includes('data-from="1" data-to="4"'));
      ok(fs.readFileSync(result.dot, "utf8").includes('"1" -> "4"'));
      eq(path.basename(result.svg), "collatz-1-10.svg");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }],
  ["Visualization: long bigint inputs produce Windows-safe output filenames", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-collatz-visual-bigint-"));
    try {
      const result = saveCollatzGraphFiles(collatzGraph(1n << 200n, 1), {
        outputDir: tmp,
        useGraphviz: false,
      });
      ok(path.basename(result.svg).length < 90);
      ok(fs.existsSync(result.svg));
      ok(fs.existsSync(result.dot));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }],
  ["Visualization: renderer handles single-vertex graph with no edges", () => {
    const svg = collatzGraphToSvg(collatzGraph(6, 1));
    eq((svg.match(/data-node="/g) ?? []).length, 1);
    eq((svg.match(/data-from="/g) ?? []).length, 0);
    ok(svg.includes('data-node="6"'));
  }],
];
