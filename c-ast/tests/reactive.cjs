'use strict';
/** Differential tests: legacy parser is an independent reference, never a production dependency. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCParser, parseCSource, parseTokens, lex, CParseError } = require('../../dist/c-ast');
const { createLexerMachine, advanceLexer, tokensFromLexer } = require('../../dist/c-ast/language/lexer-machine');
const { createParserMachine, advanceParser } = require('../../dist/c-ast/language/parser-machine');
const root = path.resolve(__dirname, '../..');
let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✔ ${name}`); }
  catch (error) { failed++; console.error(`  ✘ ${name}:`, error.stack || error); }
}
const fixture = name => fs.readFileSync(path.join(root, 'c-ast/fixtures', name), 'utf8');
const reference = (source, filename='<input>') => parseTokens(lex(source, filename), filename);
function stepAll(source, filename='<input>') {
  let s = createLexerMachine(source,filename);
  let tokens=0;
  while(!s.finished){
    const old=s;
    s=advanceLexer(s);
    assert.notStrictEqual(old,s); assert.ok(s.offset>=old.offset);
    tokens++;
    assert.equal(s.tokenCount,tokens);
    assert.ok(tokens<10000);
  }
  const all=tokensFromLexer(s);
  let m=createParserMachine(all,filename);
  const steps=[];
  while(m.status!=='completed') {
    const old=m;
    m=advanceParser(m);
    assert.equal(m.transitions,old.transitions+1);
    assert.ok(m.cursor>=old.cursor, 'cursor cannot rewind');
    assert.ok(m.cursor<=all.length-1, 'cursor out of bounds');
    steps.push(m);
    assert.ok(steps.length<100000);
  }
  assert.equal(m.tasks.length,0);
  assert.equal(m.values.length,0);
  return {ast:m.ast, steps, tokens:all, builtNodes:m.builtNodes};
}
const sample = [
  '', 'int x;', 'const char *name(int id);', 'int *a, b = 3;',
  'int f(){return 1+2*3;}', 'int f(){return (1+2)*3;}',
  'void f(){for(;;)break; for(int i=0;i<3;i++){continue;}}',
  'int f(int n){if(n>0) return n;else return -n;}',
  'int main(){return a=b=c;}', 'int main(){return a||b?1:2;}',
  'int main(){return foo(1,bar(2,3),4);}', 'int main(){return arr[i++] + obj.m;}',
  'int main(){char s = 2; do s--; while(s>0); return s;}',
  'float x = 1.5e-3F; long y = 0xFFUL;',
  '#define SUM(a,b) ((a)+\\\n(b))\nint main(){return SUM(1,2);}',
  fixture('factorial.c'), fixture('control-flow.c'),
];
check('17 grammar inputs produce byte-for-byte matching AST via lexer/parser microsteps', () => {
  for(const src of sample) {
    const independent=reference(src);
    const result=stepAll(src);
    assert.deepEqual(result.ast,independent);
    assert.equal(JSON.stringify(result.ast),JSON.stringify(independent));
  }
});
check('no hidden mutable parser state: same snapshot can branch deterministically', () => {
  let state=createParserMachine(lex('int f(){return 1+2*3;}'));
  for(let i=0;i<18;i++) state=advanceParser(state);
  const snapshot=structuredClone(state);
  const a=advanceParser(state), b=advanceParser(snapshot);
  assert.deepEqual(a,b);
  assert.deepEqual(state,snapshot, 'advanceParser did not mutate its input');
});
check('lexical positions and EOF match original lexer on both fixtures', () => {
  for(const src of sample) {
    const machine=stepAll(src);
    assert.deepEqual(machine.tokens,lex(src));
  }
});
check('token and AST-node callbacks report exactly the committed structures', () => {
  const tokens=[],nodes=[];
  const parser=createCParser({batchSize:3,onToken:t=>tokens.push(t),onNode:n=>nodes.push(n)});
  try {
    const src=fixture('factorial.c');
    const result=parser.parse(src);
    assert.deepEqual(tokens,lex(src));
    assert.equal(nodes.length,result.metrics.nodeCount);
    assert.equal(nodes.at(-1).kind,'TranslationUnit');
    assert.equal(nodes.filter(n=>n.kind==='FunctionDeclaration').length,2);
    assert.ok(Object.isFrozen(result.ast), 'public AST is deeply frozen by Store');
  } finally { parser.dispose(); }
});
check('manual begin/advance(1) follows both stages without scheduling other work', () => {
  const parser=createCParser({batchSize:7});
  try {
    let p=parser.begin('int f(){return 2+3*4;}');
    assert.equal(p.stage,'lexing');
    assert.throws(()=>parser.result(),/not completed/);
    const trajectory=[];
    while(p.stage==='lexing'||p.stage==='parsing') {
      const prev=p;
      p=parser.advance(1);
      trajectory.push([p.stage,p.tokens,p.grammarTransitions,p.stackDepth]);
      assert.ok(p.tokens >= prev.tokens);
      assert.ok(p.grammarTransitions >= prev.grammarTransitions);
      assert.ok(trajectory.length<2000);
    }
    assert.equal(p.stage,'completed');
    assert.deepEqual(parser.result().ast,reference('int f(){return 2+3*4;}'));
    assert.ok(trajectory.some(x=>x[0]==='lexing'));
    assert.ok(trajectory.some(x=>x[0]==='parsing'));
  } finally { parser.dispose(); }
});
check('resume after stopping in middle of lexer', () => {
  const parser=createCParser({batchSize:5});
  try {
    parser.begin(fixture('factorial.c'));
    parser.advance(3);
    assert.equal(parser.progress().stage,'lexing');
    assert.deepEqual(parser.resume().ast,reference(fixture('factorial.c')));
  } finally { parser.dispose(); }
});
check('resume after stopping in middle of grammar continuation stack', () => {
  const parser=createCParser({batchSize:5});
  try {
    const src=fixture('control-flow.c');
    parser.begin(src);
    parser.advance(1000);
    assert.equal(parser.progress().stage,'parsing');
    parser.advance(17);
    assert.ok(parser.progress().stackDepth>0);
    assert.deepEqual(parser.resume().ast,reference(src));
  } finally { parser.dispose(); }
});
check('different batch sizes produce identical AST, token counts and metrics', () => {
  const src=fixture('control-flow.c');
  let expected=null;
  for(const batchSize of [1,2,3,7,24,64,256]) {
    const parser=createCParser({batchSize});
    try {
      const result=parser.parse(src);
      if(expected) assert.deepEqual(result,expected);
      else expected=result;
    } finally { parser.dispose(); }
  }
});
check('100 generated programs: reference AST equals Nexus AST', () => {
  const parser=createCParser();
  try {
    for(let k=0;k<100;k++) {
      const src=`int helper${k}(int n) { int sum = ${k}; for (int i=0;i<${k%9};i++) { sum += n*i; } if(sum>10) return sum+1; else return sum-1; }`;
      assert.deepEqual(parser.parse(src).ast,reference(src));
    }
  } finally { parser.dispose(); }
});
check('malformed input: source location and reason match independent reader', () => {
  const bad=[
    'int f(){\nint x=;\n}', 'int main(){return ( ;}',
    'int main(){return 3', 'int main(){return a+b ? 1;}',
    'int f(){int a[3;}', 'void f(){while(x) if( )break;}',
    '/* missing end', 'int f(){return "x;}', 'int main(){@}',
    'struct S { int x; };', 'int f(){return 42;'
  ];
  for(const src of bad) {
    let expected;
    try { reference(src,'bad.c'); } catch (e) {expected=e;}
    assert.ok(expected instanceof CParseError);
    let actual;
    try { parseCSource(src,'bad.c'); } catch(e) {actual=e;}
    assert.ok(actual instanceof CParseError,`${src}: ${actual}`);
    assert.equal(actual.reason,expected.reason);
    assert.deepEqual(actual.position,expected.position);
  }
});
check('transition budget rejects and leaves a failed observable state', () => {
  const p=createCParser({maxTransitions:2,batchSize:10});
  try {
    assert.throws(()=>p.parse('int f(){return 1+2;}'), /exceeded 2 transitions/);
    assert.equal(p.progress().stage,'failed');
    assert.throws(()=>p.result(), RangeError);
  } finally { p.dispose(); }
});
check('begin after failure resets token stream and continuation stacks', () => {
  const p=createCParser();
  try {
    assert.throws(()=>p.parse('int a = ;'));
    assert.equal(p.progress().stage,'failed');
    p.begin('int okay;');
    assert.equal(p.progress().tokens,0);
    assert.equal(p.progress().grammarTransitions,0);
    assert.deepEqual(p.resume().ast,reference('int okay;'));
  } finally { p.dispose(); }
});
check('AST remains usable after disposal, and invalid operations reject', () => {
  const p=createCParser();
  const result=p.parse('int foo(){return 3;}');
  p.dispose();
  assert.deepEqual(result.ast,reference('int foo(){return 3;}'));
  assert.throws(()=>p.begin('int x;'),/disposed/);
  assert.throws(()=>p.advance(),/disposed/);
});
check('invalid options rejected before registering any state', () => {
  assert.throws(()=>createCParser({batchSize:0}),RangeError);
  assert.throws(()=>createCParser({maxTransitions:-1}),RangeError);
  assert.throws(()=>createCParser({onToken:2}),TypeError);
});
check('two independent Nexus parser sessions can interleave manual steps', () => {
  const first=createCParser({batchSize:2}), second=createCParser({batchSize:11});
  try {
    first.begin('int left(){return 1+2*3;}');
    second.begin('int right(){for(int i=0;i<3;i++){} return 4;}');
    for(let i=0;i<7;i++) { first.advance(2); second.advance(3); }
    assert.deepEqual(first.resume().ast,reference('int left(){return 1+2*3;}'));
    assert.deepEqual(second.resume().ast,reference('int right(){for(int i=0;i<3;i++){} return 4;}'));
  } finally { first.dispose(); second.dispose(); }
});
check('CLI --trace keeps standard output valid JSON and records committed steps to stderr', () => {
  const cli=path.join(root,'dist/c-ast/cli/main.js');
  const fixtureFile=path.join(root,'c-ast/fixtures/factorial.c');
  const proc=spawnSync(process.execPath,[cli,fixtureFile,'--stdout','--trace','--batch-size=1'],{encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout),reference(fixture('factorial.c')));
  assert.match(proc.stderr,/token .* keyword/);
  assert.match(proc.stderr,/node .* TranslationUnit/);
});
check('token callback receives frozen data, not mutable interpreter state', () => {
  let callbackCount=0;
  const parser=createCParser({onToken:token=>{
    callbackCount++;
    assert.ok(Object.isFrozen(token));
    assert.ok(Object.isFrozen(token.span));
    assert.ok(Object.isFrozen(token.span.start));
  }});
  try {
    const res=parser.parse('int main(){return 9;}');
    assert.equal(callbackCount,res.tokenCount+1);
  } finally {parser.dispose();}
});
console.log(`\nReactive C parser: ${passed}/${passed+failed} passed`);
if(failed) process.exitCode=1;
