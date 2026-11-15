import type { ParserTask, ParserVM } from './parser-vm';
import type { TopLevel, TranslationUnit, Statement, Parameter, Expression, VariableDeclarator } from './ast';
import { task, node, finish } from './parser-vm';

export function executeDeclaration(operation: ParserTask, vm: ParserVM): boolean {
  const { state, values, peek, is, consume, expect, fail, schedule, push, pop, lastEnd, isType, readType, readName, startVariable } = vm;
  switch (operation.op) {
    case 'unitLoop': {
      const declarations = operation.declarations as TopLevel[];
      if (peek().kind === 'eof') {
        const top = node('TranslationUnit', state.tokens[0]!.span.start, peek().span.end, { declarations }) as TranslationUnit;
        if (values.length) throw new Error('internal parser error: remaining AST values');
        vm.complete(top);
      } else schedule(task('top'), task('unitAppend', { declarations }));
      break;
    }
    case 'unitAppend': {
      const declaration = pop<TopLevel>();
      schedule(task('unitLoop', { declarations: [...operation.declarations, declaration] }));
      break;
    }
    case 'top': {
      if (peek().kind === 'directive') {
        const t = consume(); push(node('PreprocessorDirective', t.span.start, t.span.end, { text: t.text }));
        break;
      }
      if (!isType()) fail(`expected a declaration, found ${vm.found()}`);
      const { first, type } = readType();
      const { name, pointerDepth } = readName();
      if (is('(')) {
        consume();
        schedule(task('paramsLoop', { params: [] }),
          task('functionTail', { first, type: { ...type, pointerDepth }, name: name!.text }));
      } else startVariable(type, first, name!, pointerDepth, name!.span.start);
      break;
    }
    case 'functionTail': {
      const parameters = pop<Parameter[]>();
      if (is(';')) {
        const semi = consume();
        push(node('FunctionDeclaration', operation.first, semi.span.end,
          { returnType: operation.type, name: operation.name, parameters, body: null }));
      } else schedule(task('block'), task('functionBuild', { first: operation.first, type: operation.type, name: operation.name, parameters }));
      break;
    }
    case 'functionBuild': {
      const body = pop<Statement>();
      push(node('FunctionDeclaration', operation.first, finish(body),
        { returnType: operation.type, name: operation.name, parameters: operation.parameters, body }));
      break;
    }
    case 'paramsLoop': {
      const params = operation.params as Parameter[];
      if (is(')')) { consume(); push(params); break; }
      if (is('void') && peek(1).text === ')') { consume(); consume(); push(params); break; }
      if (!isType()) fail('expected parameter type');
      const { first, type } = readType();
      const { name, pointerDepth } = readName(true);
      schedule(task('paramTail', { first, type: { ...type, pointerDepth }, name: name?.text ?? null, sizes: [] }),
        task('paramAppend', { params }));
      break;
    }
    case 'paramAppend': {
      const p = pop<Parameter>();
      const params = [...operation.params, p];
      if (is(',')) { consume(); schedule(task('paramsLoop', { params })); }
      else { expect(')'); push(params); }
      break;
    }
    case 'paramTail':
    case 'declaratorTail': {
      if (is('[')) {
        consume();
        if (is(']')) { consume(); schedule(task(operation.op, { ...operation, sizes: [...operation.sizes, null] })); }
        else schedule(task('expression'), task('expect', { text: ']' }), task('arrayAppend', { tail: operation }));
      } else if (operation.op === 'declaratorTail' && is('=')) {
        consume(); schedule(task('assignment'), task('declaratorFinish', { tail: operation, initialized: true }));
      } else if (operation.op === 'declaratorTail') {
        push(node('VariableDeclarator', operation.start, lastEnd(),
          { name: operation.name.text, pointerDepth: operation.pointerDepth, arraySizes: operation.sizes, initializer: null }));
      } else {
        push(node('Parameter', operation.first, lastEnd(),
          { type: operation.type, name: operation.name, arraySizes: operation.sizes }));
      }
      break;
    }
    case 'arrayAppend': {
      const size = pop<Expression>();
      const tail = operation.tail as ParserTask;
      schedule(task(tail.op, { ...tail, sizes: [...tail.sizes, size] }));
      break;
    }
    case 'declaratorFinish': {
      const init = operation.initialized ? pop<Expression>() : null;
      const tail = operation.tail as ParserTask;
      push(node('VariableDeclarator', tail.start, lastEnd(),
        { name: tail.name.text, pointerDepth: tail.pointerDepth, arraySizes: tail.sizes, initializer: init }));
      break;
    }
    case 'variableLoop': {
      const declaration = pop<VariableDeclarator>();
      const list = [...operation.list, declaration];
      if (is(',')) {
        consume();
        const { start, pointerDepth, name } = readName();
        schedule(task('declaratorTail', { name, pointerDepth, start, sizes: [] }),
          task('variableLoop', { ...operation, list }));
      } else {
        const semi = expect(';');
        push(node('VariableDeclaration', operation.first, semi.span.end, { type: operation.type, declarators: list }));
      }
      break;
    }
    default: return false;
  }
  return true;
}
