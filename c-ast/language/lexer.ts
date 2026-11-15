import type { Position, Span } from "./ast";
import { CParseError } from "./errors";
export type TokenKind = "identifier" | "keyword" | "number" | "string" | "char" | "symbol" | "directive" | "eof";
export interface Token { readonly kind: TokenKind; readonly text: string; readonly span: Span }
const KEYWORDS = new Set([
  "int", "void", "char", "float", "double", "long", "short", "unsigned", "signed", "_Bool",
  "const", "static", "extern", "volatile", "if", "else", "while", "do", "for", "return",
  "break", "continue", "sizeof", "switch", "case", "default", "struct", "union", "enum", "typedef",
]);
const SYMBOLS = [
  "<<=", ">>=", "++", "--", "->", "<=", ">=", "==", "!=", "&&", "||", "<<", ">>",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "...",
  ";", ",", "(", ")", "{", "}", "[", "]", "+", "-", "*", "/", "%", "=", "!", "~", "?", ":", ".", "<", ">", "&", "|", "^",
];
const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isId = (c: string): boolean => /[A-Za-z_0-9]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);

export function lex(source: string, filename = "<input>"): readonly Token[] {
  let i = 0, line = 1, column = 1, atLineStart = true;
  const result: Token[] = [];
  const pos = (): Position => ({ offset: i, line, column });
  const next = (): string => {
    const c = source[i++]!;
    if (c === "\n") { line++; column = 1; atLineStart = true; }
    else { column++; if (c !== " " && c !== "\t" && c !== "\r") atLineStart = false; }
    return c;
  };
  const take = (until: number): void => { while (i < until) next(); };
  const emit = (kind: TokenKind, start: Position): void => {
    result.push({ kind, text: source.slice(start.offset, i), span: { start, end: pos() } });
  };
  while (i < source.length) {
    const c = source[i]!, start = pos();
    if (/\s/.test(c)) { next(); continue; }
    if (c === "#" && atLineStart) {
      next();
      while (i < source.length) {
        if (source[i] === "\\" && (source[i + 1] === "\n" || (source[i + 1] === "\r" && source[i + 2] === "\n"))) {
          next(); if (source[i] === "\r") next(); next(); continue;
        }
        if (source[i] === "\n") break;
        next();
      }
      emit("directive", start); continue;
    }
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") next();
      continue;
    }
    if (source.startsWith("/*", i)) {
      next(); next();
      while (i < source.length && !source.startsWith("*/", i)) next();
      if (i >= source.length) throw new CParseError(filename, start, "unterminated block comment");
      next(); next(); continue;
    }
    if (isIdStart(c)) {
      next(); while (i < source.length && isId(source[i]!)) next();
      const text = source.slice(start.offset, i);
      emit(KEYWORDS.has(text) ? "keyword" : "identifier", start);
      continue;
    }
    if (isDigit(c) || (c === "." && i + 1 < source.length && isDigit(source[i + 1]!))) {
      const rest = source.slice(i);
      const hex = /^0[xX][0-9a-fA-F]+(?:[uUlL]+)?/.exec(rest);
      const decimal = /^(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?:[fFlLuU]*)/.exec(rest);
      const match = hex ?? decimal;
      if (!match || !match[0]) throw new CParseError(filename, start, "invalid numeric literal");
      take(i + match[0].length);
      if (i < source.length && isIdStart(source[i]!)) throw new CParseError(filename, start, "invalid numeric suffix");
      emit("number", start); continue;
    }
    if (c === '"' || c === "'") {
      const quote = next(); let closed = false;
      while (i < source.length) {
        if (source[i] === "\n") throw new CParseError(filename, start, "newline inside literal");
        const ch = next();
        if (ch === "\\") {
          if (i >= source.length) break;
          next();
        } else if (ch === quote) { closed = true; break; }
      }
      if (!closed) throw new CParseError(filename, start, "unterminated literal");
      emit(quote === '"' ? "string" : "char", start); continue;
    }
    const symbol = SYMBOLS.find(s => source.startsWith(s, i));
    if (!symbol) throw new CParseError(filename, start, `unexpected character ${JSON.stringify(c)}`);
    take(i + symbol.length); emit("symbol", start);
  }
  const end = pos();
  result.push({ kind: "eof", text: "", span: { start: end, end } });
  return result;
}
