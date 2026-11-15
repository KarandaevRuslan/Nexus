/* Regression and conformance tests for the C-subset application (no Nexus changes). */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseCSource, createCParser, lex, CParseError } = require('../../dist/c-ast');
const root = path.resolve(__dirname, '../..');
const fixture = name => fs.readFileSync(path.join(root, 'c-ast', 'fixtures', name), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; process.stdout.write(`  ✔ ${name}\n`); }
  catch (err) { fail++; process.stderr.write(`  ✘ ${name}: ${err.stack || err}\n`); }
};
const program = src => parseCSource(src).ast;
const defs = ast => ast.declarations.filter(d => d.kind === 'FunctionDeclaration');
const body = ast => defs(ast)[0].body.statements;
const ret = source => body(program(`int main(){return ${source};}`))[0].argument;
const err = (source, needle, line, column) => {
  assert.throws(() => parseCSource(source, 'bad.c'), e => {
    assert.ok(e instanceof CParseError, `expected CParseError, got ${e.constructor.name}`);
    assert.match(e.message, new RegExp(needle));
    if (line !== undefined) assert.equal(e.position.line, line);
    if (column !== undefined) assert.equal(e.position.column, column);
    return true;
  });
};

check('empty translation unit', () => assert.deepEqual(program('').declarations, []));
check('factorial fixture: two function definitions', () => {
  const result = parseCSource(fixture('factorial.c'));
  assert.equal(result.ast.kind, 'TranslationUnit');
  assert.equal(result.metrics.functions, 2);
  assert.equal(result.metrics.functionDefinitions, 2);
  assert.equal(result.ast.declarations[0].kind, 'PreprocessorDirective');
  assert.equal(result.ast.declarations[0].text, '#include <stdio.h>');
  assert.equal(defs(result.ast)[0].parameters[0].name, 'n');
  assert.equal(defs(result.ast)[0].body.statements[1].kind, 'ForStatement');
});
check('control-flow fixture: prototype, pointers, array and do/while', () => {
  const ast = program(fixture('control-flow.c'));
  assert.equal(defs(ast).length, 2);
  assert.equal(defs(ast)[0].body, null);
  assert.equal(defs(ast)[1].parameters[0].type.pointerDepth, 1);
  assert.equal(ast.declarations[2].declarators[0].arraySizes[0].raw, '3');
  assert.equal(defs(ast)[1].body.statements[1].kind, 'WhileStatement');
  assert.equal(defs(ast)[1].body.statements[2].kind, 'DoWhileStatement');
});
check('precedence multiplication binds tighter than plus', () => {
  const e = ret('1 + 2 * 3');
  assert.equal(e.operator, '+'); assert.equal(e.right.operator, '*');
});
check('precedence parentheses override multiplication', () => {
  const e = ret('(1 + 2) * 3');
  assert.equal(e.operator, '*'); assert.equal(e.left.operator, '+');
});
check('division associates left', () => {
  const e = ret('12 / 3 / 2');
  assert.equal(e.operator, '/'); assert.equal(e.left.operator, '/');
});
check('logical precedence', () => {
  const e = ret('x < 3 || y != 4 && z');
  assert.equal(e.kind, 'LogicalExpression'); assert.equal(e.operator, '||');
  assert.equal(e.right.operator, '&&');
});
check('assignment associates right', () => {
  const ast = program('int main(){a = b = c;}');
  const expr = body(ast)[0].expression;
  assert.equal(expr.kind, 'AssignmentExpression'); assert.equal(expr.right.kind, 'AssignmentExpression');
});
check('ternary precedence below logical or', () => {
  const e = ret('a || b ? 2 : 3');
  assert.equal(e.kind, 'ConditionalExpression'); assert.equal(e.test.operator, '||');
});
check('argument comma not mistaken for sequence expression', () => {
  const e = ret('f(1, g(2, 3), 4)');
  assert.equal(e.kind, 'CallExpression'); assert.equal(e.arguments.length, 3);
  assert.equal(e.arguments[1].arguments.length, 2);
});
check('comma expression within return is a single expression', () => {
  assert.equal(ret('x = 1, x + 2').kind, 'SequenceExpression');
});
check('index and postincrement', () => {
  const e = ret('arr[i++]');
  assert.equal(e.kind, 'IndexExpression'); assert.equal(e.index.kind, 'UpdateExpression');
  assert.equal(e.index.prefix, false);
});
check('member access via pointer', () => {
  const e = ret('ptr->value + obj.count');
  assert.equal(e.left.kind, 'MemberExpression'); assert.equal(e.left.operator, '->');
  assert.equal(e.right.operator, '.');
});
check('pointer expression unary dereference', () => assert.equal(ret('*p').operator, '*'));
check('function prototypes and pointer return types', () => {
  const fn = defs(program('const char *name(int id);'))[0];
  assert.equal(fn.returnType.pointerDepth, 1);
  assert.equal(fn.returnType.name, 'const char');
  assert.equal(fn.body, null);
});
check('variable multi-declarators with distinct pointers', () => {
  const ast = program('int *a, b = 3;');
  const decl = ast.declarations[0];
  assert.equal(decl.declarators.length, 2);
  assert.equal(decl.declarators[0].pointerDepth, 1);
  assert.equal(decl.declarators[1].pointerDepth, 0);
});
check('if/else nesting and explicit return', () => {
  const ast = program('int f(int n){if(n>0) return n; else return -n;}');
  assert.equal(body(ast)[0].kind, 'IfStatement');
  assert.equal(body(ast)[0].alternate.kind, 'ReturnStatement');
});
check('for with and without conditions', () => {
  const ast = program('void f(){ for(;;) break; for(int i=0;i<3;i++){continue;} }');
  assert.equal(body(ast)[0].test, null);
  assert.equal(body(ast)[1].init.kind, 'VariableDeclaration');
  assert.equal(body(ast)[1].update.kind, 'UpdateExpression');
});
check('string literal containing comments is preserved', () => {
  const e = ret('printf("not // a comment, not /* a comment */")');
  assert.equal(e.arguments[0].raw, '"not // a comment, not /* a comment */"');
});
check('nested block comments recognized as text only until first */', () => {
  const tokens = lex('/* ignore */ int x;');
  assert.equal(tokens[0].text, 'int');
});
check('C escaped literal with embedded quote', () => {
  assert.equal(ret("'\\''").raw, "'\\''");
});
check('hex and scientific notation preserved verbatim', () => {
  const ast = program('float x = 1.5e-3F; long y = 0xFFUL;');
  assert.equal(ast.declarations[0].declarators[0].initializer.raw, '1.5e-3F');
  assert.equal(ast.declarations[1].declarators[0].initializer.raw, '0xFFUL');
});
check('all nodes have stable, JSON-safe source positions', () => {
  const ast = program('int f(){\r\n  return 7;\r\n}\r\n');
  const returnStmt = body(ast)[0];
  assert.equal(returnStmt.span.start.line, 2);
  assert.equal(returnStmt.span.start.column, 3);
  assert.equal(JSON.parse(JSON.stringify(ast)).kind, 'TranslationUnit');
});
check('multiline preprocessor directive kept as one node', () => {
  const ast = program('#define ADD(a,b) ((a) + \\\n(b))\nint main(){return 0;}');
  assert.equal(ast.declarations[0].kind, 'PreprocessorDirective');
  assert.equal(defs(ast).length, 1);
});
check('syntax error identifies bad initializer', () => err('int main(){\nint x = ;\n}', 'expected expression', 2, 9));
check('unclosed block gives diagnostic', () => err('int main(){return 3;', 'unclosed block'));
check('unterminated block comment gives diagnostic', () => err('/* missing', 'unterminated block comment', 1, 1));
check('unterminated string gives diagnostic', () => err('int x = "abc;', 'unterminated literal'));
check('invalid character gives diagnostic', () => err('int main(){@}', 'unexpected character'));
check('unsupported struct is rejected rather than silently misparsed', () => err('struct S {int a;};', 'expected a declaration'));
check('semantic errors are not evaluated', () => {
  const ast = program('int main(){return undeclared(1); }');
  assert.equal(defs(ast).length, 1);
});
check('same service can parse repeatedly, including after failure', () => {
  const parser = createCParser();
  try {
    assert.equal(parser.parse('int foo(){return 1;}').metrics.functions, 1);
    assert.throws(() => parser.parse('int bar(){return ( ;}'));
    assert.equal(parser.parse('int a; int b;').ast.declarations.length, 2);
    assert.equal(parser.parse('char x;').ast.declarations[0].type.name, 'char');
  } finally { parser.dispose(); }
});
check('disposed parser cannot parse', () => {
  const parser = createCParser(); parser.dispose();
  assert.throws(() => parser.parse('int x;'), /disposed/);
});
check('AST metrics agree with independent visitor', () => {
  const result = parseCSource(fixture('factorial.c'));
  const count = node => !node || typeof node !== 'object' ? 0 :
    Array.isArray(node) ? node.reduce((s, n) => s + count(n), 0) :
    typeof node.kind !== 'string' ? 0 :
    1 + Object.entries(node).filter(([k]) => k !== 'span').reduce((s, [,v]) => s + count(v), 0);
  assert.equal(result.metrics.nodeCount, count(result.ast));
});
check('50 generated functions roundtrip to independent AST check', () => {
  const parser = createCParser();
  try {
    for (let k = 0; k < 50; k++) {
      const code = `int f${k}(int x) { int z = ${k}; for (int i = 0; i < ${k % 7}; i++) { z += x * i; } return z; }`;
      const result = parser.parse(code);
      assert.equal(result.ast.declarations[0].name, `f${k}`);
      assert.equal(result.ast.declarations[0].body.statements[0].declarators[0].initializer.raw, `${k}`);
      assert.equal(result.metrics.functionDefinitions, 1);
    }
  } finally { parser.dispose(); }
});
check('CLI writes AST to explicit JSON path and stdout', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-c-ast-'));
  try {
    const output = path.join(temp, 'ast.json');
    const cli = path.resolve(root, 'dist/c-ast/cli/main.js');
    const input = path.resolve(root, 'c-ast/fixtures/factorial.c');
    const written = spawnSync(process.execPath, [cli, input, output], {encoding: 'utf8'});
    assert.equal(written.status, 0, written.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).kind, 'TranslationUnit');
    const streamed = spawnSync(process.execPath, [cli, input, '--stdout'], {encoding: 'utf8'});
    assert.equal(streamed.status, 0, streamed.stderr);
    assert.equal(JSON.parse(streamed.stdout).kind, 'TranslationUnit');
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
check('CLI failure returns nonzero and source location', () => {
  const cli = path.resolve(root, 'dist/c-ast/cli/main.js');
  const input = path.resolve(root, 'c-ast/fixtures/invalid.c');
  const result = spawnSync(process.execPath, [cli, input], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid\.c:2:13/);
  assert.match(result.stderr, /Syntax error/);
});
console.log(`\nC AST application: ${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;
