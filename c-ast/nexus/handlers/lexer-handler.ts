import { Context, Handler, type ReadContext } from '../../../src/core';
import type { Token } from '../../language/lexer';
import { CParseError } from '../../language/errors';
import { advanceLexer, tokensFromLexer } from '../../language/lexer-machine';
import { createParserMachine } from '../../language/parser-machine';
import type { ParserPorts, RunState } from '../pipeline';
import { failRun } from './failure';

/** One bounded batch of token transitions, then a transactional continuation. */
export class LexerHandler extends Handler {
  constructor(private readonly ports: ParserPorts) {
    super({ on: { any: [ports.signals.lex] }, execution: 'inline', delivery: 'each' });
  }
  override when(ctx: ReadContext): boolean {
    const event = ctx.event(this.ports.signals.lex)?.value;
    const run = ctx.read(this.ports.stores.run);
    return !!event && event.runId === run.id && run.stage === 'lexing';
  }
  override run(ctx: Context): void {
    const event = ctx.event(this.ports.signals.lex)!.value;
    const { stores, signals, config, scope } = this.ports;
    let current = ctx.read(stores.lexer).value!;
    const produced: Token[] = [];
    try {
      for (let i = 0; i < event.budget && !current.finished; i++) {
        if (current.transitions >= config.maxTransitions) throw new RangeError(`C lexer exceeded ${config.maxTransitions} transitions`);
        current = advanceLexer(current);
        produced.push(current.head!.token);
      }
    } catch (error) {
      if (!(error instanceof CParseError || error instanceof RangeError)) throw error;
      failRun(ctx, stores, event.runId, error,
        { offset: current.offset, line: current.line, column: current.column }, current.filename);
      return;
    }
    ctx.set(stores.lexer, { runId: event.runId, value: current });
    if (config.onToken) for (const token of produced) {
      ctx.effect(() => config.onToken!(token), { owner: scope });
    }
    if (current.finished) {
      ctx.set(stores.parser, { runId: event.runId, value: createParserMachine(tokensFromLexer(current), current.filename) });
      ctx.set(stores.run, { id: event.runId, stage: 'parsing' } as RunState);
      if (event.automatic) ctx.emit(signals.parse, { runId: event.runId, budget: config.batchSize, automatic: true });
    } else if (event.automatic) ctx.emit(signals.lex, event);
  }
}
