/** Diagnostic stepping example. Not part of Nexus Core. */
import { createCParser } from '../index';
declare const process: { argv: readonly string[]; stdout: { write(text: string): void } };
declare function require(id: string): { readFileSync(file: string, encoding: string): string };
const fs = require('node:fs');
const file = process.argv[2] ?? 'c-ast/fixtures/factorial.c';
const source = fs.readFileSync(file, 'utf8');
const parser = createCParser({ batchSize: 16 });
try {
  let progress = parser.begin(source, file);
  process.stdout.write(`start: ${progress.stage}, cursor=${progress.sourceOffset}\n`);
  let ticks = 0;
  while (progress.stage === 'lexing' || progress.stage === 'parsing') {
    progress = parser.advance(16);
    ticks++;
    if (ticks % 5 === 0 || progress.stage === 'completed') {
      process.stdout.write(`tick=${ticks} stage=${progress.stage} tokens=${progress.tokens} ` +
        `grammar=${progress.grammarTransitions} cursor=${progress.parserCursor} frames=${progress.stackDepth}\n`);
    }
  }
  const result = parser.result();
  process.stdout.write(`completed: ${result.metrics.nodeCount} AST nodes, ${result.tokenCount} tokens\n`);
} finally { parser.dispose(); }
