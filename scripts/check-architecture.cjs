#!/usr/bin/env node
'use strict';
/** Static architecture gate for TypeScript value, type and export dependencies.
 * Exit nonzero for a forbidden edge or executable import cycle. Type-only cycles
 * are measured and reported, not confused with CommonJS require cycles.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : path.join(__dirname, '..'));
const source = path.join(root, 'src');
const json = process.argv.includes('--json');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(ent => {
    const filename = path.join(dir, ent.name);
    return ent.isDirectory() ? walk(filename) : filename.endsWith('.ts') && !filename.endsWith('.d.ts') ? [filename] : [];
  });
}
function area(filename) {
  const rel = path.relative(source, filename).replaceAll(path.sep, '/');
  const [top, folder] = rel.split('/');
  return top === 'core' ? `core/${rel.split('/').length > 2 ? folder : 'facade'}`
    : top === 'frida' ? `frida/${rel.split('/').length > 2 ? folder : 'facade'}` : 'entrypoint';
}
const allow = {
  'entrypoint': ['entrypoint', 'core/facade', 'frida/facade'],
  'core/facade': ['core/facade','core/diagnostics','core/internal','core/lifecycle','core/reactions','core/scheduling','core/state','core/transactions'],
  'core/internal': ['core/internal','core/facade','core/scheduling'],
  'core/diagnostics': ['core/diagnostics','core/internal'],
  'core/lifecycle': ['core/lifecycle','core/facade'],
  'core/state': ['core/state','core/facade','core/internal'],
  'core/transactions': ['core/transactions','core/facade','core/internal','core/state','core/scheduling'],
  'core/reactions': ['core/reactions','core/facade','core/internal','core/state','core/scheduling','core/transactions'],
  'core/scheduling': ['core/scheduling','core/facade','core/internal','core/transactions'],
  'frida/facade': ['frida/facade','frida/native','frida/java','frida/il2cpp','frida/managed'],
  'frida/native': ['frida/native','core/facade','core/internal','entrypoint'],
  'frida/java': ['frida/java','frida/managed','entrypoint','core/facade'],
  'frida/il2cpp': ['frida/il2cpp','frida/managed','entrypoint','core/facade'],
  'frida/managed': ['frida/managed','core/facade','core/internal','entrypoint'],
};
// Only these reverse/upward edges are type-only exceptions; type-only imports
// count in the graph and must still be listed (not silently exempted).
const typeOnly = new Set([
  'core/internal -> core/facade', 'core/internal -> core/scheduling',
  'core/lifecycle -> core/facade', // ScopeRelations only references Scope identity
  'core/state -> core/facade', // Store / Context ownership types; runtime imports below are primitive facades
  'core/transactions -> core/scheduling',
  'core/reactions -> core/scheduling', // except CausalChain used as runtime in registration-manager, see below
  'core/reactions -> core/state',
  'core/reactions -> core/transactions',
  'core/scheduling -> core/transactions',
]);
// Exempt the named, intentional runtime primitives in core/state and reactions.
// A new runtime dependency needs an explicit review / rule change.
const runtimeExceptions = new Set([
  'core/state/state-table.ts -> core/errors.ts',
  'core/state/state-table.ts -> core/internal/contracts-runtime.ts',
  'core/state/state-table.ts -> core/store.ts',
  'core/state/value-snapshot.ts -> core/store.ts',
  'core/reactions/registration-manager.ts -> core/scheduling/causality.ts',
]);
function resolve(from, request) {
  if (!request.startsWith('.')) return null;
  const value = path.resolve(path.dirname(from), request);
  const found = [value, `${value}.ts`, path.join(value, 'index.ts')].find(x => x.endsWith('.ts') && fs.existsSync(x));
  return found && found.endsWith('.ts') ? found : null;
}
const edges = [];
const problems = [];
const files = walk(source);
for (const file of files) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) continue;
    const target = resolve(file, node.moduleSpecifier.text);
    if (!target) continue;
    const named = ts.isImportDeclaration(node) && node.importClause?.namedBindings;
    const isType = Boolean(node.isTypeOnly || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
      (named && ts.isNamedImports(named) && named.elements.length && named.elements.every(e => e.isTypeOnly)));
    edges.push({ from: file, to: target, type: isType ? 'type' : 'runtime' });
  }
  function calls(node) {
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0]) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const target = resolve(file, node.arguments[0].text);
      if (target) edges.push({ from: file, to: target, type: 'runtime' });
    }
    ts.forEachChild(node, calls);
  }
  calls(ast);
}
const relative = p => path.relative(source, p).replaceAll(path.sep, '/');
for (const edge of edges) {
  const a=area(edge.from), b=area(edge.to), pair=`${a} -> ${b}`;
  const detail = `${relative(edge.from)} -> ${relative(edge.to)}`;
  if (a.startsWith('core/') && b.startsWith('frida/')) problems.push(`core -> Frida forbidden: ${detail}`);
  if (!(allow[a] || []).includes(b)) problems.push(`New/forbidden subsystem dependency ${pair}: ${detail}`);
  if (typeOnly.has(pair) && edge.type === 'runtime' && !runtimeExceptions.has(detail)) {
    problems.push(`Only type imports permitted for ${pair}: ${detail}`);
  }
  if (a === 'core/scheduling' && edge.type === 'runtime' && relative(edge.to) === 'core/dispatcher.ts') {
    problems.push(`Scheduler imports Dispatcher runtime: ${detail}`);
  }
  if (a === 'core/transactions' && relative(edge.to).startsWith('core/reactions/')) {
    problems.push(`Transactions must use PublicationPort, not concrete reactions: ${detail}`);
  }
  if (a === 'core/state' && /^(core\/(scheduling|reactions)|frida\/)/.test(relative(edge.to))) {
    problems.push(`State imports upper subsystem: ${detail}`);
  }
  if (a === 'frida/managed' && /^frida\/(java|il2cpp)\//.test(relative(edge.to))) {
    problems.push(`Shared managed code imports bridge: ${detail}`);
  }
}
function stronglyConnected(useTypes) {
  const adjacent=new Map(files.map(f=>[f,[]]));
  for(const e of edges) if(useTypes || e.type==='runtime') adjacent.get(e.from)?.push(e.to);
  let next=0; const indexes=new Map(),low=new Map(),stack=[],onStack=new Set(),components=[];
  function visit(v) {
    indexes.set(v,next);low.set(v,next++);stack.push(v);onStack.add(v);
    for(const w of adjacent.get(v) || []) {
      if(!indexes.has(w)){visit(w);low.set(v,Math.min(low.get(v),low.get(w)));}
      else if(onStack.has(w))low.set(v,Math.min(low.get(v),indexes.get(w)));
    }
    if(low.get(v)===indexes.get(v)){
      const group=[];let w;
      do {w=stack.pop();onStack.delete(w);group.push(w);} while(w!==v);
      if(group.length>1 || (adjacent.get(v)||[]).includes(v))components.push(group.map(relative).sort());
    }
  }
  for(const f of files)if(!indexes.has(f))visit(f);
  return components;
}
const runtimeCycles=stronglyConnected(false), allCycles=stronglyConnected(true);
for (const group of runtimeCycles) problems.push('Runtime import cycle: '+group.join(' -> '));
const pairs=new Map();
for(const e of edges){const pair=`${area(e.from)} -> ${area(e.to)}`;const count=pairs.get(pair)||{runtime:0,type:0};count[e.type]++;pairs.set(pair,count);}
const result={ok: problems.length===0, files:files.length, edges:edges.length,
  runtimeEdges:edges.filter(e=>e.type==='runtime').length,typeEdges:edges.filter(e=>e.type==='type').length,
  runtimeCycles, typeInclusiveCycles:allCycles, pairs:Object.fromEntries([...pairs].sort()), problems};
if(json)console.log(JSON.stringify(result,null,2));
else {
  console.log(`Architecture: ${result.files} files, ${result.runtimeEdges} runtime + ${result.typeEdges} type edges, ${runtimeCycles.length} runtime cycles, ${allCycles.length} type-inclusive SCCs.`);
  for(const e of problems)console.error('FAIL '+e);
  if(!problems.length)console.log('PASS all dependency boundaries');
}
process.exitCode=problems.length?1:0;
