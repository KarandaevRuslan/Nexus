import type { ParserTask, ParserVM } from './parser-vm';
import type { Expression } from './ast';
import type { Token } from './lexer';
import { task, node, begin, finish } from './parser-vm';

const ASSIGNMENT_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);
const PREFIX_OPS = new Set(['+', '-', '!', '~', '*', '&', '++', '--']);
const LOGICAL_OPS = new Set(['&&', '||']);
const PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

export function executeExpression(operation: ParserTask, vm: ParserVM): boolean {
  const { values, peek, is, consume, expect, identifier, fail, schedule, push, pop, lastEnd } = vm;
  switch (operation.op) {
    case 'expression': schedule(task('assignment'), task('sequenceTail')); break;
    case 'sequenceTail': {
      if (is(',')) {
        consume(); schedule(task('assignment'), task('sequenceBuild'), task('sequenceTail'));
      }
      break;
    }
    case 'sequenceBuild': {
      const right = pop<Expression>(), left = pop<Expression>();
      push(node('SequenceExpression', begin(left), finish(right),
        { expressions: left.kind === 'SequenceExpression' ? [...(left as any).expressions, right] : [left, right] }));
      break;
    }
    case 'assignment': schedule(task('conditional'), task('assignmentTail')); break;
    case 'assignmentTail': {
      const op = peek().text;
      if (ASSIGNMENT_OPS.has(op)) {
        const left = values[values.length - 1] as Expression;
        if (!(left.kind === 'Identifier' || left.kind === 'IndexExpression' || left.kind === 'MemberExpression' ||
          (left.kind === 'UnaryExpression' && left.operator === '*'))) fail('left side of assignment is not assignable');
        consume(); schedule(task('assignment'), task('assignmentBuild', { operator: op }));
      }
      break;
    }
    case 'assignmentBuild': {
      const right = pop<Expression>(), left = pop<Expression>();
      push(node('AssignmentExpression', begin(left), finish(right), { operator: operation.operator, left, right }));
      break;
    }
    case 'conditional': schedule(task('binary', { minimum: 1 }), task('conditionalTail')); break;
    case 'conditionalTail': {
      if (is('?')) {
        consume(); schedule(task('expression'), task('expect', { text: ':' }), task('assignment'), task('conditionalBuild'));
      }
      break;
    }
    case 'conditionalBuild': {
      const alternate = pop<Expression>(), consequent = pop<Expression>(), test = pop<Expression>();
      push(node('ConditionalExpression', begin(test), finish(alternate), { test, consequent, alternate }));
      break;
    }
    case 'binary': schedule(task('unary'), task('binaryTail', { minimum: operation.minimum })); break;
    case 'binaryTail': {
      const op = peek().text, precedence = PRECEDENCE[op] ?? 0;
      if (precedence >= operation.minimum) {
        consume(); schedule(task('binary', { minimum: precedence + 1 }), task('binaryBuild', { operator: op }),
          task('binaryTail', { minimum: operation.minimum }));
      }
      break;
    }
    case 'binaryBuild': {
      const right = pop<Expression>(), left = pop<Expression>();
      push(node(LOGICAL_OPS.has(operation.operator) ? 'LogicalExpression' : 'BinaryExpression',
        begin(left), finish(right), { operator: operation.operator, left, right }));
      break;
    }
    case 'unary': {
      const token = peek();
      if (PREFIX_OPS.has(token.text)) {
        consume(); schedule(task('unary'), task('unaryBuild', { token }));
      } else schedule(task('postfix'));
      break;
    }
    case 'unaryBuild': {
      const argument = pop<Expression>(), op = (operation.token as Token).text;
      push(op === '++' || op === '--'
        ? node('UpdateExpression', operation.token.span.start, finish(argument), { operator: op, argument, prefix: true })
        : node('UnaryExpression', operation.token.span.start, finish(argument), { operator: op, argument }));
      break;
    }
    case 'postfix': schedule(task('primary'), task('postfixTail')); break;
    case 'postfixTail': {
      if (is('(')) {
        consume(); const callee = pop<Expression>();
        schedule(task('callArgs', { callee, args: [] }), task('postfixTail'));
      } else if (is('[')) {
        consume(); schedule(task('expression'), task('expect', { text: ']' }), task('indexBuild'), task('postfixTail'));
      } else if (is('.') || is('->')) {
        const operator = consume().text, property = identifier(); const object = pop<Expression>();
        push(node('MemberExpression', begin(object), property.span.end,
          { object, property: property.text, operator }));
        schedule(task('postfixTail'));
      } else if (is('++') || is('--')) {
        const op = consume(), argument = pop<Expression>();
        push(node('UpdateExpression', begin(argument), op.span.end,
          { operator: op.text, prefix: false, argument }));
        schedule(task('postfixTail'));
      }
      break;
    }
    case 'callArgs': {
      if (is(')')) {
        const close = consume(); const callee = operation.callee as Expression;
        push(node('CallExpression', begin(callee), close.span.end,
          { callee, arguments: operation.args }));
      } else schedule(task('assignment'), task('callArgAppend', { callee: operation.callee, args: operation.args }));
      break;
    }
    case 'callArgAppend': {
      const arg = pop<Expression>(), args = [...operation.args, arg];
      if (is(',')) { consume(); schedule(task('callArgs', { callee: operation.callee, args })); }
      else {
        const close = expect(')'); const callee = operation.callee as Expression;
        push(node('CallExpression', begin(callee), close.span.end, { callee, arguments: args }));
      }
      break;
    }
    case 'indexBuild': {
      const index = pop<Expression>(), object = pop<Expression>();
      push(node('IndexExpression', begin(object), lastEnd(), { object, index }));
      break;
    }
    case 'primary': {
      const t = peek();
      if (t.kind === 'identifier') {
        consume(); push(node('Identifier', t.span.start, t.span.end, { name: t.text }));
      } else if (t.kind === 'number' || t.kind === 'char' || t.kind === 'string') {
        consume(); push(node('Literal', t.span.start, t.span.end, { literalType: t.kind, raw: t.text }));
      } else if (is('(')) {
        consume(); schedule(task('expression'), task('expect', { text: ')' }));
      } else fail(`expected expression, found ${vm.found()}`);
      break;
    }
    default: return false;
  }
  return true;
}
