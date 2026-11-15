/** One bounded grammar instruction per call. Nexus owns the explicit continuation stack. */
import type { Token } from './lexer';
import { createVm, task, type ParserMachineState } from './parser-vm';
import { executeDeclaration } from './grammar-declarations';
import { executeStatement } from './grammar-statements';
import { executeExpression } from './grammar-expressions';
export type { ParserMachineState, ParserTask } from './parser-vm';

export function createParserMachine(tokens: readonly Token[], filename = '<input>'): ParserMachineState {
  if (!tokens.length || tokens[tokens.length - 1]?.kind !== 'eof') throw new Error('internal parser error: missing EOF token');
  return { filename, tokens, cursor: 0, tasks: [task('unitLoop', { declarations: [] })],
    values: [], transitions: 0, status: 'running', ast: null, builtNodes: 0, lastNode: null };
}
export function advanceParser(state: ParserMachineState): ParserMachineState {
  if (state.status !== 'running') return state;
  const vm = createVm(state);
  const op = vm.operation;
  if (!executeDeclaration(op, vm) && !executeStatement(op, vm) && !executeExpression(op, vm)) {
    throw new Error(`internal parser error: unknown grammar operation ${op.op}`);
  }
  return vm.nextState();
}
