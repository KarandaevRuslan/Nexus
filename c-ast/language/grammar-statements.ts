import type { ParserTask, ParserVM } from './parser-vm';
import type { Statement, Expression, VariableDeclaration } from './ast';
import { task, node, begin, finish } from './parser-vm';

export function executeStatement(operation: ParserTask, vm: ParserVM): boolean {
  const { peek, is, consume, expect, fail, schedule, push, pop, lastEnd, isType, readType, readName, startVariable } = vm;
  switch (operation.op) {
    case 'block': {
      const brace = expect('{');
      schedule(task('blockLoop', { first: brace.span.start, list: [] }));
      break;
    }
    case 'blockLoop': {
      if (is('}')) {
        const brace = consume();
        push(node('BlockStatement', operation.first, brace.span.end, { statements: operation.list }));
      } else if (peek().kind === 'eof') fail("unclosed block: expected '}'");
      else schedule(task('statement'), task('blockAppend', { first: operation.first, list: operation.list }));
      break;
    }
    case 'blockAppend': {
      const statement = pop<Statement>();
      schedule(task('blockLoop', { first: operation.first, list: [...operation.list, statement] }));
      break;
    }
    case 'statement': {
      const current = peek(), first = current.span.start;
      if (is('{')) { schedule(task('block')); break; }
      if (is('if')) {
        consume(); expect('(');
        schedule(task('expression'), task('expect', { text: ')' }), task('statement'), task('ifElse', { first }));
      } else if (is('while')) {
        consume(); expect('(');
        schedule(task('expression'), task('expect', { text: ')' }), task('statement'), task('whileBuild', { first }));
      } else if (is('do')) {
        consume(); schedule(task('statement'), task('expect', { text: 'while' }), task('expect', { text: '(' }),
          task('expression'), task('expect', { text: ')' }), task('expect', { text: ';' }), task('doBuild', { first }));
      } else if (is('for')) {
        consume(); expect('(');
        schedule(task('forInit'), task('forTest'), task('forUpdate'), task('statement'), task('forBuild', { first }));
      } else if (is('return')) {
        consume();
        if (is(';')) { const semi = consume(); push(node('ReturnStatement', first, semi.span.end, { argument: null })); }
        else schedule(task('expression'), task('expect', { text: ';' }), task('returnBuild', { first }));
      } else if (is('break') || is('continue')) {
        const word = consume(), semi = expect(';');
        push(node(word.text === 'break' ? 'BreakStatement' : 'ContinueStatement', first, semi.span.end, {}));
      } else if (isType()) {
        const { type, first: typeStart } = readType();
        const { start, name, pointerDepth } = readName();
        startVariable(type, typeStart, name!, pointerDepth, start);
      } else if (is(';')) {
        const semi = consume(); push(node('EmptyStatement', first, semi.span.end, {}));
      } else schedule(task('expression'), task('expect', { text: ';' }), task('expressionStmtBuild'));
      break;
    }
    case 'expect': expect(operation.text); break;
    case 'ifElse': {
      if (is('else')) { consume(); schedule(task('statement'), task('ifBuild', { first: operation.first, alternate: true })); }
      else schedule(task('ifBuild', { first: operation.first, alternate: false }));
      break;
    }
    case 'ifBuild': {
      const alternate = operation.alternate ? pop<Statement>() : null;
      const consequent = pop<Statement>(); const test = pop<Expression>();
      push(node('IfStatement', operation.first, finish(alternate ?? consequent), { test, consequent, alternate }));
      break;
    }
    case 'whileBuild': {
      const body = pop<Statement>(), test = pop<Expression>();
      push(node('WhileStatement', operation.first, finish(body), { test, body }));
      break;
    }
    case 'doBuild': {
      const test = pop<Expression>(), body = pop<Statement>();
      push(node('DoWhileStatement', operation.first, lastEnd(), { body, test }));
      break;
    }
    case 'forInit': {
      if (isType()) {
        const { type, first } = readType(); const { start, name, pointerDepth } = readName();
        startVariable(type, first, name!, pointerDepth, start);
      } else if (is(';')) { consume(); push(null); }
      else schedule(task('expression'), task('expect', { text: ';' }));
      break;
    }
    case 'forTest': {
      if (is(';')) { consume(); push(null); }
      else schedule(task('expression'), task('expect', { text: ';' }));
      break;
    }
    case 'forUpdate': {
      if (is(')')) { consume(); push(null); }
      else schedule(task('expression'), task('expect', { text: ')' }));
      break;
    }
    case 'forBuild': {
      const body = pop<Statement>(), update = pop<Expression | null>(), test = pop<Expression | null>();
      const init = pop<VariableDeclaration | Expression | null>();
      push(node('ForStatement', operation.first, finish(body), { init, test, update, body }));
      break;
    }
    case 'returnBuild': {
      const argument = pop<Expression>();
      push(node('ReturnStatement', operation.first, lastEnd(), { argument }));
      break;
    }
    case 'expressionStmtBuild': {
      const expression = pop<Expression>();
      push(node('ExpressionStatement', begin(expression), lastEnd(), { expression }));
      break;
    }
    default: return false;
  }
  return true;
}
