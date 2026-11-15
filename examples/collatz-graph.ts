/**
 * A bounded Collatz + successor directed graph built with Nexus Events and Stores.
 *
 * For each DISTINCT discovered positive integer n, consider:
 *   (1) n -> collatz(n), INCLUDING 1 -> 4 (the graph has no terminal 1);
 *   (2) n -> n + 1.
 *
 * Discover and process vertices in FIFO/BFS order, Collatz edge first. There
 * would be infinitely many vertices because of n -> n + 1, therefore `limit`
 * is a STRICT upper bound on the number of distinct vertices. An edge to an
 * undiscovered vertex when at capacity is omitted; edges to already present
 * vertices are retained. All discovered vertices are fully processed.
 *
 * One 'expand' Event occurrence schedules one Handler run / one transaction.
 * The graph Store is a frozen immutable value, updated only through ctx.set().
 * There is no direct invocation of another Handler or mutation of external
 * state inside Handler.run().
 */
import { Context, Dispatcher, Handler, type ReadContext } from "../src/core";

export type CollatzGraphEdgeKind = "collatz" | "increment";

export interface CollatzGraphEdge {
  readonly from: bigint;
  readonly to: bigint;
  readonly kind: CollatzGraphEdgeKind;
}

export interface CollatzGraphResult {
  readonly start: bigint;
  readonly limit: number;
  /** Vertices in BFS discovery order, with no duplicates. */
  readonly vertices: readonly bigint[];
  /** Directed, labelled edges whose BOTH endpoints occur in `vertices`. */
  readonly edges: readonly CollatzGraphEdge[];
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly primeCount: number;
  /** Edges towards undiscovered vertices suppressed by the vertex limit. */
  readonly omittedTransitions: number;
  /** Always true for a completed finite exploration: n -> n + 1 never ends. */
  readonly truncated: boolean;
}

interface GraphState {
  readonly runId: number;
  readonly start: bigint;
  readonly limit: number;
  readonly vertices: readonly bigint[];
  readonly edges: readonly CollatzGraphEdge[];
  readonly processed: number;
  readonly primeCount: number;
  readonly omittedTransitions: number;
}

interface ExpandMessage {
  readonly runId: number;
  readonly vertex: bigint;
}

const SIXTY_FOUR_BITS = 1n << 64n;
// These seven bases deterministically test every unsigned 64-bit integer.
const BASES_64 = [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n] as const;
const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n] as const;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let power = base % modulus;
  while (exponent > 0n) {
    if ((exponent & 1n) !== 0n) result = (result * power) % modulus;
    power = (power * power) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** Exact primality test; deterministic Miller–Rabin below 2^64. */
export function isPrimeBigInt(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }

  if (n < SIXTY_FOUR_BITS) {
    let d = n - 1n;
    let s = 0;
    while ((d & 1n) === 0n) { d >>= 1n; s++; }
    for (const base of BASES_64) {
      if (base % n === 0n) continue;
      let x = modPow(base, d, n);
      if (x === 1n || x === n - 1n) continue;
      let reachedMinusOne = false;
      for (let r = 1; r < s; r++) {
        x = (x * x) % n;
        if (x === n - 1n) { reachedMinusOne = true; break; }
      }
      if (!reachedMinusOne) return false;
    }
    return true;
  }

  // For integers >= 2^64, retain exactness (not a probabilistic answer) at
  // the expense of potentially VERY slow trial division for large primes.
  let candidate = 41n;
  while (candidate * candidate <= n) {
    if (n % candidate === 0n || n % (candidate + 2n) === 0n) return false;
    candidate += 6n;
  }
  return true;
}

function natural(input: number | bigint): bigint {
  if (typeof input === "bigint") {
    if (input < 1n) throw new RangeError("start must be a positive integer");
    return input;
  }
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new RangeError("start must be a positive safe integer, or use bigint");
  }
  return BigInt(input);
}

function nodeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > Number.MAX_SAFE_INTEGER - 4) {
    throw new RangeError("limit must be a positive safe integer <= MAX_SAFE_INTEGER - 4");
  }
  return limit;
}

function frozenState(
  runId: number, start: bigint, limit: number,
  vertices: bigint[], edges: CollatzGraphEdge[], processed: number,
  primeCount: number, omittedTransitions: number,
): GraphState {
  return Object.freeze({
    runId, start, limit,
    vertices: Object.freeze(vertices), edges: Object.freeze(edges),
    processed, primeCount, omittedTransitions,
  });
}

export interface CollatzGraphExplorer {
  /** Reuse the same Dispatcher/Handler for different inputs; synchronous. */
  explore(start: number | bigint, limit?: number): CollatzGraphResult;
  /** Unregister owned Store, Event and Handler. */
  dispose(): void;
}

/**
 * Create a reusable explorer, with a fixed upper bound for Nexus wave budgets.
 * Every call may request a smaller limit. The default budget is 1000 vertices.
 */
export function createCollatzGraphExplorer(maxVertices = 1000): CollatzGraphExplorer {
  const budget = nodeLimit(maxVertices);
  const dispatcher = new Dispatcher({
    maxInlineWaves: budget + 4,
    maxCausalWaves: budget + 4,
  });
  const scope = dispatcher.scope();
  const expand = scope.event<ExpandMessage>();
  // Reference mode is safe ONLY because the entire reachable graph is frozen
  // and every graph update creates new immutable containers.
  const graph = scope.store<GraphState>(
    frozenState(0, 1n, 1, [1n], [], 1, 0, 0),
    { storage: "reference" },
  );
  let nextRunId = 0;
  let busy = false;

  class ExpandVertex extends Handler {
    constructor() {
      super({ on: { any: [expand] }, execution: "inline", delivery: "each" });
    }

    override when(ctx: ReadContext): boolean {
      const message = ctx.event(expand)?.value;
      if (!message) return false;
      const current = ctx.read(graph);
      return message.runId === current.runId
        && current.processed < current.vertices.length
        && current.vertices[current.processed] === message.vertex;
    }

    override run(ctx: Context): void {
      const message = ctx.event(expand)!.value;
      const previous = ctx.read(graph);
      const from = message.vertex;
      const vertices = [...previous.vertices];
      const edges = [...previous.edges];
      const discovered = new Set(vertices);
      let primeCount = previous.primeCount;
      let omittedTransitions = previous.omittedTransitions;

      // Unlike a terminal Collatz sequence, a graph expands every vertex:
      // 1 -> 4 (Collatz) and 1 -> 2 (increment). Cycles are safe because
      // each discovered vertex is expanded exactly once.
      const candidates: Array<readonly [CollatzGraphEdgeKind, bigint]> = [
        ["collatz", from % 2n === 0n ? from / 2n : 3n * from + 1n],
        ["increment", from + 1n],
      ];

      for (const [kind, to] of candidates) {
        if (!discovered.has(to)) {
          if (vertices.length >= previous.limit) {
            omittedTransitions++;
            continue;
          }
          discovered.add(to);
          vertices.push(to);
          if (isPrimeBigInt(to)) primeCount++;
        }
        edges.push(Object.freeze({ from, to, kind }));
      }

      const processed = previous.processed + 1;
      ctx.set(graph, frozenState(
        previous.runId, previous.start, previous.limit, vertices, edges,
        processed, primeCount, omittedTransitions,
      ));
      if (processed < vertices.length) {
        // One event per commit -> no same-wave writes racing for the graph Store.
        ctx.emit(expand, { runId: previous.runId, vertex: vertices[processed]! });
      }
    }
  }

  scope.register(new ExpandVertex());

  function explore(input: number | bigint, requestedLimit = budget): CollatzGraphResult {
    if (!scope.active) throw new Error("Collatz graph explorer has been disposed");
    if (busy) throw new Error("Collatz graph explorer does not support reentrant explore()");
    const start = natural(input);
    const limit = nodeLimit(requestedLimit);
    if (limit > budget) throw new RangeError(`limit cannot exceed explorer budget ${budget}`);
    if (nextRunId >= Number.MAX_SAFE_INTEGER) throw new RangeError("Run counter exhausted");
    const runId = ++nextRunId;

    busy = true;
    try {
      dispatcher.inline(ctx => {
        ctx.set(graph, frozenState(runId, start, limit, [start], [], 0, isPrimeBigInt(start) ? 1 : 0, 0));
        ctx.emit(expand, { runId, vertex: start });
      });
      // Outer inline() returns only after the whole inline Event chain drains.
      const finished = dispatcher.inline(ctx => ctx.read(graph));
      if (finished.runId !== runId || finished.processed !== finished.vertices.length) {
        throw new Error("Collatz graph expansion did not finish synchronously");
      }
      return Object.freeze({
        start, limit,
        vertices: finished.vertices,
        edges: finished.edges,
        vertexCount: finished.vertices.length,
        edgeCount: finished.edges.length,
        primeCount: finished.primeCount,
        omittedTransitions: finished.omittedTransitions,
        truncated: finished.omittedTransitions > 0,
      });
    } finally { busy = false; }
  }

  return Object.freeze({ explore, dispose: () => scope.dispose() });
}

/** Simple repeatable two-argument function. Builds an isolated Scope per call. */
export function collatzGraph(start: number | bigint, limit: number): CollatzGraphResult {
  const explorer = createCollatzGraphExplorer(limit);
  try { return explorer.explore(start, limit); }
  finally { explorer.dispose(); }
}

/** Export the complete graph as Graphviz DOT without needing a rendering tool. */
export function collatzGraphToDot(result: CollatzGraphResult): string {
  const lines: string[] = ["digraph CollatzSuccessor {", "  rankdir=LR;"];
  for (const vertex of result.vertices) {
    const label = vertex.toString();
    const primeStyle = isPrimeBigInt(vertex) ? ', shape=doublecircle' : '';
    lines.push(`  "${label}" [label="${label}"${primeStyle}];`);
  }
  for (const edge of result.edges) {
    const label = edge.kind === "collatz" ? "3n+1 / n÷2" : "+1";
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${label}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}
