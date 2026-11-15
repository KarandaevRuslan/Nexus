import { Dispatcher } from '../../src/core';
import type { AstMetrics, TranslationUnit, Span } from '../language/ast';
import type { Token } from '../language/lexer';
import type { SourceInput, Pulse, Signal, Failure, ParserPorts, RunState, Stage } from './pipeline';
import { StartHandler } from './handlers/start-handler';
import { LexerHandler } from './handlers/lexer-handler';
import { ParserHandler } from './handlers/parser-handler';
import { MetricsHandler } from './handlers/metrics-handler';
import { CParseError } from '../language/errors';
import type { LexerMachineState } from '../language/lexer-machine';
import type { ParserMachineState } from '../language/parser-machine';

export interface CParseResult {
  readonly ast: TranslationUnit;
  readonly metrics: AstMetrics;
  readonly tokenCount: number;
}
export interface CParserProgress {
  readonly runId: number;
  readonly stage: 'idle' | 'lexing' | 'parsing' | 'completed' | 'failed';
  readonly tokens: number;
  readonly sourceOffset: number;
  readonly sourceLength: number;
  readonly grammarTransitions: number;
  readonly parserCursor: number;
  readonly stackDepth: number;
}
export interface CParserOptions {
  /** Number of bounded lexer/parser transitions per automatic reactive wave. */
  readonly batchSize?: number;
  /** Stops malformed or unexpectedly expensive input without unbounded propagation. */
  readonly maxTransitions?: number;
  /** Observational callbacks run only after the containing Nexus commit. */
  readonly onToken?: (token: Token) => void;
  readonly onNode?: (node: { readonly kind: string; readonly span: Span }) => void;
}
export interface CParserService {
  /** Automatically drive Lexer + Parser through Nexus events to completion. */
  parse(source: string, filename?: string): CParseResult;
  /** Begin a session without automatically scheduling more steps. */
  begin(source: string, filename?: string): CParserProgress;
  /** Advance at most `steps` lexical or grammar transitions and return progress. */
  advance(steps?: number): CParserProgress;
  /** Continue a manually stepped session automatically to completion. */
  resume(): CParseResult;
  progress(): CParserProgress;
  /** Return completed result; throw if incomplete or failed. */
  result(): CParseResult;
  dispose(): void;
}
const positiveInt = (name: string, n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return n;
};

/**
 * Nexus owns the continuation: Start Event -> LexPulse Event -> Lexer Store
 * -> ParsePulse Event -> Parser Store -> AstReady Event -> Metrics Store.
 * The lexical/grammar transition functions have no hidden mutable state;
 * they run only inside their respective Handler.run transactions.
 * Neither lex() nor parseTokens() is used by this execution path.
 */
export function createCParser(options: CParserOptions = {}): CParserService {
  const batchSize = positiveInt('batchSize', options.batchSize ?? 24);
  const maxTransitions = positiveInt('maxTransitions', options.maxTransitions ?? 2_000_000);
  if (options.onToken !== undefined && typeof options.onToken !== 'function') throw new TypeError('onToken must be a function');
  if (options.onNode !== undefined && typeof options.onNode !== 'function') throw new TypeError('onNode must be a function');
  const dispatcher = new Dispatcher({ maxInlineWaves: 500_000, maxCausalWaves: 500_000 });
  const scope = dispatcher.scope();
  const startEvent = scope.event<SourceInput>();
  const lexPulse = scope.event<Pulse>();
  const parsePulse = scope.event<Pulse>();
  const astReady = scope.event<Signal>();
  const runStore = scope.store<RunState>({ id: 0, stage: 'idle' });
  // These values are replaced, never mutated, at every successful Commit.
  // reference storage avoids repeatedly freezing/copying the entire source and token stream.
  const lexerStore = scope.store<Stage<LexerMachineState>>({ runId: 0, value: null }, { storage: 'reference' });
  const parserStore = scope.store<Stage<ParserMachineState>>({ runId: 0, value: null }, { storage: 'reference' });
  const astStore = scope.store<Stage<TranslationUnit>>({ runId: 0, value: null });
  const metricsStore = scope.store<Stage<AstMetrics>>({ runId: 0, value: null });
  const failureStore = scope.store<Failure | null>(null);
  const ports: ParserPorts = {
    scope,
    signals: { start: startEvent, lex: lexPulse, parse: parsePulse, ast: astReady },
    stores: { run: runStore, lexer: lexerStore, parser: parserStore, ast: astStore,
      metrics: metricsStore, failure: failureStore },
    config: { batchSize, maxTransitions, onToken: options.onToken, onNode: options.onNode },
  };
  scope.register(new StartHandler(ports));
  scope.register(new LexerHandler(ports));
  scope.register(new ParserHandler(ports));
  scope.register(new MetricsHandler(ports));
  let nextId = 0;
  let entering = false;

  const checkActive = (): void => {
    if (!scope.active) throw new Error('C parser has been disposed');
    if (entering) throw new Error('C parser does not support reentrant parse()');
  };
  const run = (source: string, filename: string, automatic: boolean): CParserProgress => {
    checkActive();
    if (typeof source !== 'string') throw new TypeError('source must be a string');
    entering = true;
    try {
      const id = ++nextId;
      dispatcher.inline(ctx => ctx.emit(startEvent, { runId: id, source, filename, automatic }));
      return progress();
    } finally { entering = false; }
  };
  const progress = (): CParserProgress => dispatcher.inline(ctx => {
    const r = ctx.read(runStore);
    const lex = ctx.read(lexerStore).value;
    const parser = ctx.read(parserStore).value;
    return {
      runId: r.id, stage: r.stage, tokens: lex?.tokenCount ?? 0,
      sourceOffset: lex?.offset ?? 0, sourceLength: lex?.source.length ?? 0,
      grammarTransitions: parser?.transitions ?? 0, parserCursor: parser?.cursor ?? 0,
      stackDepth: parser?.tasks.length ?? 0,
    };
  });
  const result = (): CParseResult => dispatcher.inline(ctx => {
    const r = ctx.read(runStore);
    const failure = ctx.read(failureStore);
    if (r.stage === 'failed' && failure?.runId === r.id) {
      if (failure.kind === 'limit') throw new RangeError(failure.reason);
      throw new CParseError(failure.filename, failure.position, failure.reason);
    }
    const ast = ctx.read(astStore), metrics = ctx.read(metricsStore), lex = ctx.read(lexerStore);
    if (r.stage !== 'completed' || !ast.value || !metrics.value || !lex.value) {
      throw new Error(`C parser has not completed (stage: ${r.stage})`);
    }
    return { ast: ast.value, metrics: metrics.value, tokenCount: lex.value.tokenCount - 1 };
  });
  return {
    parse(source: string, filename = '<input>'): CParseResult { run(source, filename, true); return result(); },
    begin(source: string, filename = '<input>'): CParserProgress { return run(source, filename, false); },
    advance(steps = 1): CParserProgress {
      checkActive(); positiveInt('steps', steps);
      const p = progress();
      if (p.stage === 'lexing') dispatcher.inline(ctx => ctx.emit(lexPulse, { runId: p.runId, budget: steps, automatic: false }));
      else if (p.stage === 'parsing') dispatcher.inline(ctx => ctx.emit(parsePulse, { runId: p.runId, budget: steps, automatic: false }));
      return progress();
    },
    resume(): CParseResult {
      checkActive();
      const p = progress();
      if (p.stage === 'lexing') dispatcher.inline(ctx => ctx.emit(lexPulse, { runId: p.runId, budget: batchSize, automatic: true }));
      else if (p.stage === 'parsing') dispatcher.inline(ctx => ctx.emit(parsePulse, { runId: p.runId, budget: batchSize, automatic: true }));
      return result();
    },
    progress() { checkActive(); return progress(); },
    result() { checkActive(); return result(); },
    dispose() { scope.dispose(); },
  };
}
export function parseCSource(source: string, filename = '<input>'): CParseResult {
  const parser = createCParser();
  try { return parser.parse(source, filename); }
  finally { parser.dispose(); }
}
