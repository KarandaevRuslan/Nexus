import { Context, Handler } from '../../../src/core';
import { createLexerMachine } from '../../language/lexer-machine';
import type { ParserPorts, RunState } from '../pipeline';

/** Owns only session initialization and the first lexical pulse. */
export class StartHandler extends Handler {
  constructor(private readonly ports: ParserPorts) {
    super({ on: { any: [ports.signals.start] }, execution: 'inline', delivery: 'each' });
  }
  override run(ctx: Context): void {
    const input = ctx.event(this.ports.signals.start)?.value;
    if (!input) return;
    const { stores, signals, config } = this.ports;
    ctx.set(stores.run, { id: input.runId, stage: 'lexing' } as RunState);
    ctx.set(stores.lexer, { runId: input.runId, value: createLexerMachine(input.source, input.filename) });
    ctx.set(stores.parser, { runId: input.runId, value: null });
    ctx.set(stores.ast, { runId: input.runId, value: null });
    ctx.set(stores.metrics, { runId: input.runId, value: null });
    ctx.set(stores.failure, null);
    if (input.automatic) ctx.emit(signals.lex, { runId: input.runId, budget: config.batchSize, automatic: true });
  }
}
