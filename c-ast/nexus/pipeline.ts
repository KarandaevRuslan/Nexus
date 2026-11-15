/** Data-only wiring contract. No domain logic, scheduling or global singleton. */
import type { Event, Scope, Store } from '../../src/core';
import type { AstMetrics, TranslationUnit, Span } from '../language/ast';
import type { Token } from '../language/lexer';
import type { LexerMachineState } from '../language/lexer-machine';
import type { ParserMachineState } from '../language/parser-machine';

export interface SourceInput { readonly runId: number; readonly source: string; readonly filename: string; readonly automatic: boolean }
export interface Pulse { readonly runId: number; readonly budget: number; readonly automatic: boolean }
export interface Signal { readonly runId: number }
export interface Stage<T> { readonly runId: number; readonly value: T | null }
export interface Failure {
  readonly runId: number;
  readonly kind: 'syntax' | 'limit';
  readonly filename: string;
  readonly position: { readonly offset: number; readonly line: number; readonly column: number };
  readonly reason: string;
}
export interface RunState { readonly id: number; readonly stage: 'idle' | 'lexing' | 'parsing' | 'completed' | 'failed' }
export interface PipelineSignals {
  readonly start: Event<SourceInput>;
  readonly lex: Event<Pulse>;
  readonly parse: Event<Pulse>;
  readonly ast: Event<Signal>;
}
export interface PipelineStores {
  readonly run: Store<RunState>;
  readonly lexer: Store<Stage<LexerMachineState>>;
  readonly parser: Store<Stage<ParserMachineState>>;
  readonly ast: Store<Stage<TranslationUnit>>;
  readonly metrics: Store<Stage<AstMetrics>>;
  readonly failure: Store<Failure | null>;
}
export interface ParserConfig {
  readonly batchSize: number;
  readonly maxTransitions: number;
  readonly onToken?: (token: Token) => void;
  readonly onNode?: (node: { readonly kind: string; readonly span: Span }) => void;
}
export interface ParserPorts {
  readonly signals: PipelineSignals;
  readonly stores: PipelineStores;
  readonly scope: Scope;
  readonly config: ParserConfig;
}
