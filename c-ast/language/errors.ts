import type { Position } from "./ast";
/** A diagnostic with a stable source offset, line and 1-based column. */
export class CParseError extends Error {
  constructor(readonly filename: string, readonly position: Position, readonly reason: string) {
    super(`${filename}:${position.line}:${position.column}: ${reason}`);
    this.name = "CParseError";
  }
}
