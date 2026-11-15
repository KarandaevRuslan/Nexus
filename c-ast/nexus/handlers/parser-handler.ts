import { Context, Handler, type ReadContext } from '../../../src/core';
import type { Span } from '../../language/ast';
import { CParseError } from '../../language/errors';
import { advanceParser } from '../../language/parser-machine';
import type { ParserPorts } from '../pipeline';
import { failRun } from './failure';

/** One bounded batch of grammar instructions, then a transactional continuation. */
export class ParserHandler extends Handler {
  constructor(private readonly ports: ParserPorts) {
    super({ on: { any: [ports.signals.parse] }, execution: 'inline', delivery: 'each' });
  }
  override when(ctx: ReadContext): boolean {
    const event = ctx.event(this.ports.signals.parse)?.value;
    const run = ctx.read(this.ports.stores.run);
    return !!event && event.runId === run.id && run.stage === 'parsing';
  }
  override run(ctx: Context): void {
    const event = ctx.event(this.ports.signals.parse)!.value;
    const { stores, signals, config, scope } = this.ports;
    let current = ctx.read(stores.parser).value!;
    const built: Array<{ readonly kind: string; readonly span: Span }> = [];
    try {
      for (let i = 0; i < event.budget && current.status === 'running'; i++) {
        if (current.transitions >= config.maxTransitions) throw new RangeError(`C parser exceeded ${config.maxTransitions} transitions`);
        current = advanceParser(current);
        if (current.lastNode) built.push(current.lastNode);
      }
    } catch (error) {
      if (!(error instanceof CParseError || error instanceof RangeError)) throw error;
      failRun(ctx, stores, event.runId, error, current.tokens[current.cursor]!.span.start, current.filename);
      return;
    }
    ctx.set(stores.parser, { runId: event.runId, value: current });
    if (config.onNode) for (const node of built) {
      ctx.effect(() => config.onNode!(node), { owner: scope });
    }
    if (current.status === 'completed') {
      ctx.set(stores.ast, { runId: event.runId, value: current.ast! });
      ctx.emit(signals.ast, { runId: event.runId });
    } else if (event.automatic) ctx.emit(signals.parse, event);
  }
}
