import { createCParser } from "../index";
import { CParseError } from "../language/errors";

// Small, dependency-free Node CLI. The application is not part of Nexus Core.
declare const process: { readonly argv: readonly string[]; readonly cwd: () => string; exitCode: number; stdout: { write(data: string): void }; stderr: { write(data: string): void } };
declare function require(name: string): unknown;
interface Fs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  mkdirSync(path: string, options: { recursive: true }): void;
}
interface Path {
  resolve(...segments: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  extname(path: string): string;
  join(...parts: string[]): string;
}
const fs = require("node:fs") as Fs;
const path = require("node:path") as Path;
function usage(): string {
  return "Usage: npm run c-ast:parse -- <file.c> [output.json] [--compact] [--stdout] [--trace] [--batch-size=N]\n" +
    "       npm run c-ast:demo\n" +
    "Outputs AST JSON (not compiled C); preprocessor directives are preserved, not expanded.\n";
}
function main(): void {
  const raw = process.argv.slice(2);
  if (raw.includes("--help") || raw.includes("-h") || raw.length === 0) {
    process.stdout.write(usage());
    if (raw.length === 0) process.exitCode = 2;
    return;
  }
  const compact = raw.includes("--compact");
  const stdout = raw.includes("--stdout");
  const trace = raw.includes("--trace");
  const batchFlag = raw.find(a => a.startsWith("--batch-size="));
  const batchSize = batchFlag ? Number(batchFlag.slice("--batch-size=".length)) : undefined;
  const positional = raw.filter(a => !a.startsWith("--"));
  if (positional.length < 1 || positional.length > 2 || raw.some(a => a.startsWith("--") && a !== "--compact" && a !== "--stdout" && a !== "--trace" && !a.startsWith("--batch-size="))) {
    throw new Error(usage());
  }
  const input = path.resolve(process.cwd(), positional[0]!);
  if (!input.toLowerCase().endsWith(".c")) throw new Error("expected a .c source file");
  const source = fs.readFileSync(input, "utf8");
  const output = positional[1] ? path.resolve(process.cwd(), positional[1]) :
    path.join(path.dirname(input), path.basename(input).slice(0, -path.extname(input).length) + ".ast.json");
  const parser = createCParser({
    batchSize,
    onToken: trace ? token => process.stderr.write(`token ${token.span.start.line}:${token.span.start.column} ${token.kind} ${JSON.stringify(token.text)}\n`) : undefined,
    onNode: trace ? node => process.stderr.write(`node  ${node.span.start.line}:${node.span.start.column} ${node.kind}\n`) : undefined,
  });
  let result;
  try { result = parser.parse(source, input); }
  finally { parser.dispose(); }
  const json = JSON.stringify(result.ast, null, compact ? 0 : 2) + "\n";
  if (stdout) process.stdout.write(json);
  else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json, "utf8");
    process.stdout.write(`AST: ${output}\n`);
  }
  process.stderr.write(`Tokens: ${result.tokenCount}; AST nodes: ${result.metrics.nodeCount}; ` +
    `functions: ${result.metrics.functions}; definitions: ${result.metrics.functionDefinitions}\n`);
}
try { main(); }
catch (error) {
  if (error instanceof CParseError) process.stderr.write(`Syntax error: ${error.message}\n`);
  else process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
