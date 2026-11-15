import { Context, Handler, type ReadContext } from 'nexus/core';
import { countAstNodes } from '../../language/ast';
import type { ParserPorts, RunState } from '../pipeline';

/** Derive final metrics only after an AST has been committed. */
export class MetricsHandler extends Handler {
  constructor(private readonly ports: ParserPorts) {
    super({ on: { any: [ports.signals.ast] }, execution: 'inline', delivery: 'each' });
  }
  override when(ctx: ReadContext): boolean {
    const event = ctx.event(this.ports.signals.ast)?.value;
    const ast = ctx.read(this.ports.stores.ast);
    return !!event && event.runId === ast.runId && ast.value !== null;
  }
  override run(ctx: Context): void {
    const event = ctx.event(this.ports.signals.ast)!.value;
    const { stores } = this.ports;
    ctx.set(stores.metrics, { runId: event.runId, value: countAstNodes(ctx.read(stores.ast).value!) });
    ctx.set(stores.run, { id: event.runId, stage: 'completed' } as RunState);
  }
}
