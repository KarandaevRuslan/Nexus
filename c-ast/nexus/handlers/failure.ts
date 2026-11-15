import { Context } from 'nexus/core';
import { CParseError } from '../../language/errors';
import type { Failure, PipelineStores, RunState } from '../pipeline';

/** Record expected user syntax errors and explicit transition-budget failure. */
export function failRun(ctx: Context, stores: PipelineStores, runId: number,
  error: CParseError | RangeError,
  position: { offset: number; line: number; column: number }, filename: string): void {
  ctx.set(stores.failure, {
    runId, kind: error instanceof CParseError ? 'syntax' : 'limit',
    filename, position: error instanceof CParseError ? error.position : position,
    reason: error instanceof CParseError ? error.reason : error.message,
  } as Failure);
  ctx.set(stores.run, { id: runId, stage: 'failed' } as RunState);
}
