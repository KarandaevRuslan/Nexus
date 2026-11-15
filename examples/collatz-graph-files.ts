/** Node.js example-only I/O. Core/Frida do NOT import this module. */
import { collatzGraphToDot, type CollatzGraphResult } from "./collatz-graph";
import { collatzGraphToSvg } from "./collatz-graph-svg";

// Keep the core prototype independent of @types/node. These are the exact
// Node.js methods used by this demo (Node.js >= 22.16.0).
declare function require(id: string): unknown;
declare const process: { cwd(): string };
interface FileSystem {
  mkdirSync(path: string, options: { recursive: boolean }): unknown;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  existsSync(path: string): boolean;
  rmSync(path: string, options: { force: boolean }): void;
}
interface PathModule {
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
}
interface SpawnResult { status: number | null; error?: Error; stderr?: string }
interface ChildProcess {
  spawnSync(command: string, args: string[], options: { windowsHide: boolean; encoding: "utf8"; timeout: number }): SpawnResult;
}

export interface CollatzGraphFiles {
  readonly dot: string;
  readonly svg: string;
  readonly png?: string;
  readonly renderer: "graphviz" | "builtin";
}

export interface GraphExportOptions {
  /** Defaults to ./graphs relative to the current terminal directory. */
  readonly outputDir?: string;
  /** Disable optional Graphviz, useful for portable tests. */
  readonly useGraphviz?: boolean;
}

function filename(graph: CollatzGraphResult): string {
  const start = String(graph.start);
  if (start.length <= 40) return `collatz-${start}-${graph.limit}`;
  // Long bigint values can exceed Windows' conventional file name limit.
  let hash = 2166136261;
  for (let i = 0; i < start.length; i++) {
    hash = Math.imul(hash ^ start.charCodeAt(i), 16777619) >>> 0;
  }
  return `collatz-${start.slice(0, 24)}-${start.length}d-${hash.toString(16)}-${graph.limit}`;
}

/**
 * Always writes .dot + standalone .svg. If Graphviz (`dot`) is available in
 * PATH, overwrite SVG with its higher-quality layout and generate PNG as well.
 * Absence of Graphviz is NOT an error. Limit dot rendering to moderate graphs
 * to avoid freezing Windows for minutes on enormous layouts.
 */
export function saveCollatzGraphFiles(graph: CollatzGraphResult, options: GraphExportOptions = {}): CollatzGraphFiles {
  const fs = require("node:fs") as FileSystem;
  const path = require("node:path") as PathModule;
  const child = require("node:child_process") as ChildProcess;
  const outputDir = path.resolve(options.outputDir ?? path.join(process.cwd(), "graphs"));
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = path.join(outputDir, filename(graph));
  const dot = `${stem}.dot`;
  const svg = `${stem}.svg`;
  const png = `${stem}.png`;
  // Do not leave stale PNG output from an earlier run with Graphviz installed.
  fs.rmSync(png, { force: true });

  fs.writeFileSync(dot, collatzGraphToDot(graph), "utf8");
  fs.writeFileSync(svg, collatzGraphToSvg(graph), "utf8");

  if (options.useGraphviz === false || graph.vertexCount > 250) {
    return { dot, svg, renderer: "builtin" };
  }
  const runDot = (format: "svg" | "png", target: string): boolean => {
    try {
      const result = child.spawnSync("dot", [`-T${format}`, dot, "-o", target], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 20_000,
      });
      return result.status === 0 && fs.existsSync(target);
    } catch { return false; }
  };
  if (!runDot("svg", svg)) {
    // dot might have created a truncated file before failing. Restore fallback.
    fs.writeFileSync(svg, collatzGraphToSvg(graph), "utf8");
    return { dot, svg, renderer: "builtin" };
  }
  if (runDot("png", png)) return { dot, svg, png, renderer: "graphviz" };
  fs.rmSync(png, { force: true }); // Remove a partial PNG after failed rendering.
  return { dot, svg, renderer: "graphviz" };
}
