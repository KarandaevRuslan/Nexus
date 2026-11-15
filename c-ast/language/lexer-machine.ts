/** One immutable lexer state and one bounded token transition per invocation. */
import type { Position } from './ast';
import { CParseError } from './errors';
import type { Token, TokenKind } from './lexer';

const KEYWORDS = new Set([
  'int', 'void', 'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', '_Bool',
  'const', 'static', 'extern', 'volatile', 'if', 'else', 'while', 'do', 'for', 'return',
  'break', 'continue', 'sizeof', 'switch', 'case', 'default', 'struct', 'union', 'enum', 'typedef',
]);
const SYMBOLS = [
  '<<=', '>>=', '++', '--', '->', '<=', '>=', '==', '!=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '...',
  ';', ',', '(', ')', '{', '}', '[', ']', '+', '-', '*', '/', '%', '=', '!', '~', '?', ':', '.', '<', '>', '&', '|', '^',
];
const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isId = (c: string): boolean => /[A-Za-z_0-9]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);
interface TokenLink { readonly token: Token; readonly previous: TokenLink | null }
export interface LexerMachineState {
  readonly source: string;
  readonly filename: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly atLineStart: boolean;
  readonly finished: boolean;
  readonly head: TokenLink | null;
  readonly tokenCount: number;
  readonly transitions: number;
}
export function createLexerMachine(source: string, filename: string): LexerMachineState {
  return { source, filename, offset: 0, line: 1, column: 1, atLineStart: true,
    finished: false, head: null, tokenCount: 0, transitions: 0 };
}
export function advanceLexer(state: LexerMachineState): LexerMachineState {
  if (state.finished) return state;
  const source = state.source;
  let i = state.offset, line = state.line, column = state.column, atLineStart = state.atLineStart;
  const pos = (): Position => ({ offset: i, line, column });
  const next = (): string => {
    const c = source[i++]!;
    if (c === '\n') { line++; column = 1; atLineStart = true; }
    else { column++; if (c !== ' ' && c !== '\t' && c !== '\r') atLineStart = false; }
    return c;
  };
  const take = (until: number): void => { while (i < until) next(); };
  const immutableToken = (kind: TokenKind, text: string, start: Position, end: Position): Token =>
    Object.freeze({ kind, text, span: Object.freeze({
      start: Object.freeze({ ...start }), end: Object.freeze({ ...end }),
    }) });
  const token = (kind: TokenKind, start: Position): Token =>
    immutableToken(kind, source.slice(start.offset, i), start, pos());
  const commit = (item: Token, done = false): LexerMachineState => ({
    ...state, offset: i, line, column, atLineStart,
    head: { token: item, previous: state.head }, tokenCount: state.tokenCount + 1,
    finished: done, transitions: state.transitions + 1,
  });
  // Whitespace/comments belong to the lexical boundary before the next token.
  while (i < source.length) {
    const c = source[i]!, start = pos();
    if (/\s/.test(c)) { next(); continue; }
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') next();
      continue;
    }
    if (source.startsWith('/*', i)) {
      next(); next();
      while (i < source.length && !source.startsWith('*/', i)) next();
      if (i >= source.length) throw new CParseError(state.filename, start, 'unterminated block comment');
      next(); next(); continue;
    }
    if (c === '#' && atLineStart) {
      next();
      while (i < source.length) {
        if (source[i] === '\\' && (source[i + 1] === '\n' || (source[i + 1] === '\r' && source[i + 2] === '\n'))) {
          next(); if (source[i] === '\r') next(); next(); continue;
        }
        if (source[i] === '\n') break;
        next();
      }
      return commit(token('directive', start));
    }
    if (isIdStart(c)) {
      next(); while (i < source.length && isId(source[i]!)) next();
      const text = source.slice(start.offset, i);
      return commit(token(KEYWORDS.has(text) ? 'keyword' : 'identifier', start));
    }
    if (isDigit(c) || (c === '.' && i + 1 < source.length && isDigit(source[i + 1]!))) {
      const rest = source.slice(i);
      const hex = /^0[xX][0-9a-fA-F]+(?:[uUlL]+)?/.exec(rest);
      const decimal = /^(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?:[fFlLuU]*)/.exec(rest);
      const match = hex ?? decimal;
      if (!match || !match[0]) throw new CParseError(state.filename, start, 'invalid numeric literal');
      take(i + match[0].length);
      if (i < source.length && isIdStart(source[i]!)) throw new CParseError(state.filename, start, 'invalid numeric suffix');
      return commit(token('number', start));
    }
    if (c === '"' || c === "'") {
      const quote = next(); let closed = false;
      while (i < source.length) {
        if (source[i] === '\n') throw new CParseError(state.filename, start, 'newline inside literal');
        const ch = next();
        if (ch === '\\') { if (i >= source.length) break; next(); }
        else if (ch === quote) { closed = true; break; }
      }
      if (!closed) throw new CParseError(state.filename, start, 'unterminated literal');
      return commit(token(quote === '"' ? 'string' : 'char', start));
    }
    const symbol = SYMBOLS.find(s => source.startsWith(s, i));
    if (!symbol) throw new CParseError(state.filename, start, `unexpected character ${JSON.stringify(c)}`);
    take(i + symbol.length);
    return commit(token('symbol', start));
  }
  const end = pos();
  return commit(immutableToken('eof', '', end, end), true);
}

/** Materialize the token stream exactly once at the lexer→parser boundary. */
export function tokensFromLexer(state: LexerMachineState): readonly Token[] {
  if (!state.finished) throw new Error('Lexer has not reached EOF');
  const tokens: Token[] = [];
  for (let link = state.head; link !== null; link = link.previous) tokens.push(link.token);
  tokens.reverse();
  return tokens;
}
