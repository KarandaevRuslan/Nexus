/** Shared transactional draft for one grammar instruction, never retained between steps. */
import type { Position, Span, TranslationUnit, TypeName } from './ast';
import { CParseError } from './errors';
import type { Token } from './lexer';

const TYPE_WORDS = new Set(['int', 'void', 'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', '_Bool']);
const TYPE_QUALIFIERS = new Set(['const', 'static', 'extern', 'volatile']);

export interface ParserTask { readonly op: string; readonly [arg: string]: any }
export interface ParserMachineState {
  readonly filename: string;
  readonly tokens: readonly Token[];
  readonly cursor: number;
  readonly tasks: readonly ParserTask[];
  readonly values: readonly unknown[];
  readonly transitions: number;
  readonly status: 'running' | 'completed';
  readonly ast: TranslationUnit | null;
  readonly builtNodes: number;
  readonly lastNode: { readonly kind: string; readonly span: Span } | null;
}
export const task = (op: string, extra: Record<string, unknown> = {}): ParserTask => ({ op, ...extra });
export const node = (kind: string, a: Position, b: Position, fields: Record<string, unknown>): any =>
  ({ kind, span: { start: a, end: b }, ...fields });
export const begin = (x: { span: Span }): Position => x.span.start;
export const finish = (x: { span: Span }): Position => x.span.end;

export interface ParserVM {
  readonly state: ParserMachineState;
  readonly values: unknown[];
  readonly operation: ParserTask;
  peek(n?: number): Token;
  found(): string;
  is(text: string): boolean;
  consume(): Token;
  expect(text: string): Token;
  identifier(): Token;
  fail(message: string): never;
  schedule(...tasks: ParserTask[]): void;
  push(value: unknown): void;
  pop<T>(): T;
  lastEnd(): Position;
  isType(): boolean;
  readType(): { type: TypeName; first: Position };
  readName(optional?: boolean): { name: Token | null; pointerDepth: number; start: Position };
  startVariable(type: TypeName, first: Position, name: Token, pointerDepth: number, declStart: Position): void;
  complete(ast: TranslationUnit): void;
  nextState(): ParserMachineState;
}
export function createVm(state: ParserMachineState): ParserVM {
  const tasks = [...state.tasks], values = [...state.values];
  if (!tasks.length) throw new Error('internal parser error: empty continuation stack');
  const operation = tasks.pop()!;
  let cursor = state.cursor;
  let ast = state.ast;
  let status = state.status;
  let builtNodes = state.builtNodes;
  let lastNode: { readonly kind: string; readonly span: Span } | null = null;
  const peek = (n = 0): Token => state.tokens[Math.min(cursor + n, state.tokens.length - 1)]!;
  const is = (text: string): boolean => peek().text === text;
  const consume = (): Token => { const t = peek(); if (t.kind !== 'eof') cursor++; return t; };
  const found = (): string => peek().kind === 'eof' ? 'end of file' : JSON.stringify(peek().text);
  const fail = (message: string): never => { throw new CParseError(state.filename, peek().span.start, message); };
  const expect = (text: string): Token => {
    if (!is(text)) return fail(`expected '${text}', found ${found()}`);
    return consume();
  };
  const identifier = (): Token => {
    if (peek().kind !== 'identifier') return fail(`expected an identifier, found ${found()}`);
    return consume();
  };
  const schedule = (...ordered: ParserTask[]): void => { tasks.push(...ordered.reverse()); };
  const push = (value: unknown): void => {
    values.push(value);
    if (value && typeof value === 'object' && 'kind' in value && 'span' in value) {
      const object = value as { kind: string; span: Span };
      lastNode = Object.freeze({ kind: object.kind, span: Object.freeze({
        start: Object.freeze({ ...object.span.start }), end: Object.freeze({ ...object.span.end }),
      }) });
      builtNodes++;
    }
  };
  const pop = <T>(): T => {
    if (!values.length) throw new Error('internal parser error: value stack underflow');
    return values.pop() as T;
  };
  const lastEnd = (): Position => state.tokens[Math.max(0, cursor - 1)]!.span.end;
  const isType = (): boolean => TYPE_WORDS.has(peek().text) || TYPE_QUALIFIERS.has(peek().text);
  const readType = (): { type: TypeName; first: Position } => {
    const first = peek().span.start;
    const words: string[] = [];
    let base = false;
    while (isType()) {
      if (TYPE_WORDS.has(peek().text)) base = true;
      words.push(consume().text);
    }
    if (!base) fail('expected a primitive C type after qualifiers');
    return { first, type: { name: words.join(' '), pointerDepth: 0 } };
  };
  const readName = (optional = false): { name: Token | null; pointerDepth: number; start: Position } => {
    const start = peek().span.start;
    let pointerDepth = 0;
    while (is('*')) {
      consume(); pointerDepth++;
      while (is('const') || is('volatile')) consume();
    }
    const name = optional && peek().kind !== 'identifier' ? null : identifier();
    return { name, pointerDepth, start };
  };
  const startVariable = (type: TypeName, first: Position, name: Token, pointerDepth: number, declStart: Position): void => {
    schedule(task('declaratorTail', { name, pointerDepth, start: declStart, sizes: [] }),
      task('variableLoop', { type, first, list: [] }));
  };
  return { state, operation, values, peek, found, is, consume, expect, identifier, fail, schedule, push,
    pop, lastEnd, isType, readType, readName, startVariable,
    complete: result => { ast = result; status = 'completed'; builtNodes++; lastNode = Object.freeze({ kind: result.kind, span: Object.freeze({
      start: Object.freeze({ ...result.span.start }), end: Object.freeze({ ...result.span.end }),
    }) }); },
    nextState: () => ({ ...state, cursor, tasks, values, status, ast, builtNodes, lastNode, transitions: state.transitions + 1 }),
  };
}
