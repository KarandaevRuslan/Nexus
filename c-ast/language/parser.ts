import type {
  AssignmentExpression, BinaryExpression, BlockStatement, BreakStatement, CallExpression,
  ConditionalExpression, ContinueStatement, DoWhileStatement, EmptyStatement, Expression,
  ExpressionStatement, ForStatement, FunctionDeclaration, Identifier, IfStatement, IndexExpression,
  Literal, MemberExpression, Parameter, Position, PreprocessorDirective, ReturnStatement,
  SequenceExpression, Span, Statement, TopLevel, TranslationUnit, TypeName, UnaryExpression,
  UpdateExpression, VariableDeclaration, VariableDeclarator, WhileStatement,
} from "./ast";
import { CParseError } from "./errors";
import type { Token } from "./lexer";

const TYPE_WORDS = new Set(["int", "void", "char", "float", "double", "long", "short", "unsigned", "signed", "_Bool"]);
const TYPE_QUALIFIERS = new Set(["const", "static", "extern", "volatile"]);
const ASSIGNMENT_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);
const PRECEDENCE: Readonly<Record<string, number>> = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5,
  "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7,
  "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10,
};
const LOGICAL_OPS = new Set(["&&", "||"]);
const PREFIX_OPS = new Set(["+", "-", "!", "~", "*", "&", "++", "--"]);
const end = (span: Span): Position => span.end;
const start = (span: Span): Position => span.start;
const n = <K extends string, T extends object>(kind: K, a: Position, b: Position, data: T): { readonly kind: K; readonly span: Span } & T =>
  ({ kind, span: { start: a, end: b }, ...data });

class Reader {
  private index = 0;
  constructor(private readonly tokens: readonly Token[], private readonly filename: string) {}
  private peek(offset = 0): Token { return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!; }
  private matches(value: string): boolean { return this.peek().text === value; }
  private advance(): Token { const token = this.peek(); if (token.kind !== "eof") this.index++; return token; }
  private accept(value: string): Token | null { return this.matches(value) ? this.advance() : null; }
  private fail(message: string): never { throw new CParseError(this.filename, this.peek().span.start, message); }
  private expect(value: string): Token { if (!this.matches(value)) this.fail(`expected '${value}', found ${this.found()}`); return this.advance(); }
  private found(): string { const token = this.peek(); return token.kind === "eof" ? "end of file" : JSON.stringify(token.text); }
  private identifier(): Token { if (this.peek().kind !== "identifier") this.fail(`expected an identifier, found ${this.found()}`); return this.advance(); }
  private isType(): boolean { return TYPE_WORDS.has(this.peek().text) || TYPE_QUALIFIERS.has(this.peek().text); }
  private typeName(): { type: TypeName; first: Position } {
    const first = this.peek().span.start, words: string[] = [];
    let hasBase = false;
    while (TYPE_WORDS.has(this.peek().text) || TYPE_QUALIFIERS.has(this.peek().text)) {
      if (TYPE_WORDS.has(this.peek().text)) hasBase = true;
      words.push(this.advance().text);
    }
    if (!hasBase) this.fail("expected a primitive C type after qualifiers");
    return { type: { name: words.join(" "), pointerDepth: 0 }, first };
  }
  private pointers(): number { let count = 0; while (this.accept("*")) { count++; while (this.accept("const") || this.accept("volatile")) { /* pointer qualifiers not represented */ } } return count; }
  private arraySizes(): (Expression | null)[] {
    const result: (Expression | null)[] = [];
    while (this.accept("[")) { result.push(this.matches("]") ? null : this.expression()); this.expect("]"); }
    return result;
  }
  private variableDeclarator(prefix: number, allowInit = true): VariableDeclarator {
    const a = this.peek().span.start;
    const pointerDepth = prefix + this.pointers();
    const name = this.identifier();
    const arraySizes = this.arraySizes();
    const initializer = allowInit && this.accept("=") ? this.assignment() : null;
    return n("VariableDeclarator", a, this.tokens[this.index - 1]!.span.end,
      { name: name.text, pointerDepth, arraySizes, initializer });
  }
  private variables(type: TypeName, a: Position, first: VariableDeclarator, terminator: string): VariableDeclaration {
    const declarators = [first];
    while (this.accept(",")) declarators.push(this.variableDeclarator(0));
    const semi = this.expect(terminator);
    return n("VariableDeclaration", a, semi.span.end, { type, declarators });
  }
  public translationUnit(): TranslationUnit {
    const a = this.peek().span.start;
    const declarations: TopLevel[] = [];
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "directive") {
        this.advance();
        declarations.push(n("PreprocessorDirective", token.span.start, token.span.end, { text: token.text }) as PreprocessorDirective);
        continue;
      }
      if (!this.isType()) this.fail(`expected a declaration, found ${this.found()}`);
      const { type, first } = this.typeName();
      const pointerDepth = this.pointers();
      const name = this.identifier();
      if (this.accept("(")) {
        const parameters = this.parameters();
        const returnType = { ...type, pointerDepth };
        const body = this.accept(";") ? null : this.block();
        const b = body ? body.span.end : this.tokens[this.index - 1]!.span.end;
        declarations.push(n("FunctionDeclaration", first, b,
          { returnType, name: name.text, parameters, body }) as FunctionDeclaration);
      } else {
        const arraySizes = this.arraySizes();
        const initializer = this.accept("=") ? this.assignment() : null;
        const b = this.tokens[this.index - 1]!.span.end;
        const head = n("VariableDeclarator", name.span.start, b, { name: name.text, pointerDepth, arraySizes, initializer });
        declarations.push(this.variables(type, first, head, ";"));
      }
    }
    return n("TranslationUnit", a, this.peek().span.end, { declarations });
  }
  private parameters(): Parameter[] {
    const parameters: Parameter[] = [];
    if (this.accept(")")) return parameters;
    if (this.matches("void") && this.peek(1).text === ")") { this.advance(); this.advance(); return parameters; }
    do {
      if (!this.isType()) this.fail("expected parameter type");
      const { type, first } = this.typeName();
      const pointerDepth = this.pointers();
      const name = this.peek().kind === "identifier" ? this.advance().text : null;
      const arraySizes = name !== null ? this.arraySizes() : [];
      const b = this.tokens[this.index - 1]!.span.end;
      parameters.push(n("Parameter", first, b, { type: { ...type, pointerDepth }, name, arraySizes }));
    } while (this.accept(","));
    this.expect(")");
    return parameters;
  }
  private block(): BlockStatement {
    const open = this.expect("{");
    const statements: Statement[] = [];
    while (!this.matches("}")) {
      if (this.peek().kind === "eof") this.fail("unclosed block: expected '}'");
      statements.push(this.statement());
    }
    const close = this.expect("}");
    return n("BlockStatement", open.span.start, close.span.end, { statements });
  }
  private statement(): Statement {
    if (this.matches("{")) return this.block();
    if (this.matches("if")) {
      const a = this.advance().span.start;
      this.expect("("); const test = this.expression(); this.expect(")");
      const consequent = this.statement();
      const alternate = this.accept("else") ? this.statement() : null;
      return n("IfStatement", a, alternate ? end(alternate.span) : end(consequent.span),
        { test, consequent, alternate }) as IfStatement;
    }
    if (this.matches("while")) {
      const a = this.advance().span.start;
      this.expect("("); const test = this.expression(); this.expect(")");
      const body = this.statement();
      return n("WhileStatement", a, end(body.span), { test, body }) as WhileStatement;
    }
    if (this.matches("do")) {
      const a = this.advance().span.start;
      const body = this.statement();
      this.expect("while"); this.expect("("); const test = this.expression(); this.expect(")");
      const semi = this.expect(";");
      return n("DoWhileStatement", a, semi.span.end, { body, test }) as DoWhileStatement;
    }
    if (this.matches("for")) {
      const a = this.advance().span.start;
      this.expect("(");
      let init: VariableDeclaration | Expression | null = null;
      if (this.isType()) {
        const { type, first } = this.typeName();
        const firstVar = this.variableDeclarator(0);
        init = this.variables(type, first, firstVar, ";");
      } else if (!this.accept(";")) {
        init = this.expression(); this.expect(";");
      }
      const test = this.matches(";") ? null : this.expression(); this.expect(";");
      const update = this.matches(")") ? null : this.expression(); this.expect(")");
      const body = this.statement();
      return n("ForStatement", a, end(body.span), { init, test, update, body }) as ForStatement;
    }
    if (this.matches("return")) {
      const a = this.advance().span.start;
      const argument = this.matches(";") ? null : this.expression();
      const semi = this.expect(";");
      return n("ReturnStatement", a, semi.span.end, { argument }) as ReturnStatement;
    }
    if (this.matches("break") || this.matches("continue")) {
      const word = this.advance(); const semi = this.expect(";");
      return word.text === "break"
        ? n("BreakStatement", word.span.start, semi.span.end, {}) as BreakStatement
        : n("ContinueStatement", word.span.start, semi.span.end, {}) as ContinueStatement;
    }
    if (this.isType()) {
      const { type, first } = this.typeName();
      const head = this.variableDeclarator(0);
      return this.variables(type, first, head, ";");
    }
    if (this.matches(";")) { const t = this.advance(); return n("EmptyStatement", t.span.start, t.span.end, {}) as EmptyStatement; }
    const expression = this.expression();
    const semi = this.expect(";");
    return n("ExpressionStatement", start(expression.span), semi.span.end, { expression }) as ExpressionStatement;
  }
  private expression(): Expression {
    const first = this.assignment();
    if (!this.matches(",")) return first;
    const expressions = [first];
    while (this.accept(",")) expressions.push(this.assignment());
    return n("SequenceExpression", start(first.span), end(expressions[expressions.length - 1]!.span),
      { expressions }) as SequenceExpression;
  }
  private assignment(): Expression {
    const left = this.conditional();
    if (!ASSIGNMENT_OPS.has(this.peek().text)) return left;
    if (!this.isAssignable(left)) this.fail("left side of assignment is not assignable");
    const operator = this.advance().text;
    const right = this.assignment();
    return n("AssignmentExpression", start(left.span), end(right.span), { operator, left, right }) as AssignmentExpression;
  }
  private isAssignable(expr: Expression): boolean {
    return expr.kind === "Identifier" || expr.kind === "IndexExpression" || expr.kind === "MemberExpression" ||
      (expr.kind === "UnaryExpression" && expr.operator === "*");
  }
  private conditional(): Expression {
    const test = this.binary(1);
    if (!this.accept("?")) return test;
    const consequent = this.expression(); this.expect(":");
    const alternate = this.assignment();
    return n("ConditionalExpression", start(test.span), end(alternate.span),
      { test, consequent, alternate }) as ConditionalExpression;
  }
  private binary(minimum: number): Expression {
    let left = this.unary();
    while (true) {
      const op = this.peek().text, precedence = PRECEDENCE[op] ?? 0;
      if (precedence < minimum) break;
      this.advance();
      const right = this.binary(precedence + 1);
      left = n(LOGICAL_OPS.has(op) ? "LogicalExpression" : "BinaryExpression",
        start(left.span), end(right.span), { operator: op, left, right }) as BinaryExpression;
    }
    return left;
  }
  private unary(): Expression {
    const current = this.peek();
    if (PREFIX_OPS.has(current.text)) {
      this.advance();
      const argument = this.unary();
      const args = { operator: current.text, argument };
      return current.text === "++" || current.text === "--"
        ? n("UpdateExpression", current.span.start, end(argument.span), { ...args, prefix: true }) as UpdateExpression
        : n("UnaryExpression", current.span.start, end(argument.span), args) as UnaryExpression;
    }
    return this.postfix();
  }
  private postfix(): Expression {
    let expr = this.primary();
    while (true) {
      if (this.accept("(")) {
        const args: Expression[] = [];
        if (!this.matches(")")) { do { args.push(this.assignment()); } while (this.accept(",")); }
        const close = this.expect(")");
        expr = n("CallExpression", start(expr.span), close.span.end, { callee: expr, arguments: args }) as CallExpression;
        continue;
      }
      if (this.accept("[")) {
        const index = this.expression(); const close = this.expect("]");
        expr = n("IndexExpression", start(expr.span), close.span.end, { object: expr, index }) as IndexExpression;
        continue;
      }
      if (this.matches(".") || this.matches("->")) {
        const operator = this.advance().text as "." | "->";
        const property = this.identifier();
        expr = n("MemberExpression", start(expr.span), property.span.end,
          { object: expr, property: property.text, operator }) as MemberExpression;
        continue;
      }
      if (this.matches("++") || this.matches("--")) {
        const op = this.advance();
        expr = n("UpdateExpression", start(expr.span), op.span.end,
          { operator: op.text, prefix: false, argument: expr }) as UpdateExpression;
        continue;
      }
      return expr;
    }
  }
  private primary(): Expression {
    const token = this.peek();
    if (token.kind === "identifier") { this.advance(); return n("Identifier", token.span.start, token.span.end, { name: token.text }) as Identifier; }
    if (token.kind === "number" || token.kind === "char" || token.kind === "string") {
      this.advance();
      return n("Literal", token.span.start, token.span.end,
        { literalType: token.kind, raw: token.text }) as Literal;
    }
    if (this.accept("(")) { const expr = this.expression(); this.expect(")"); return expr; }
    this.fail(`expected expression, found ${this.found()}`);
  }
}

export function parseTokens(tokens: readonly Token[], filename = "<input>"): TranslationUnit {
  if (tokens.length === 0 || tokens[tokens.length - 1]!.kind !== "eof") {
    throw new Error("internal parser error: missing EOF token");
  }
  return new Reader(tokens, filename).translationUnit();
}
