#!/usr/bin/env node
'use strict';
/** Build a standalone JS Frida agent out of the compiled *relative* CJS graph.
 * No Node builtins and no Node-style require remain at runtime. Only modules
 * reached by the supplied entry are packed (Native profile excludes Java/IL2CPP).
 * Does not transpile TypeScript; run npm run build first.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname,'..');
const readArg = (option, fallback) => {
  const i=process.argv.indexOf(option);
  return i<0?fallback:process.argv[i+1];
};
const entry=path.resolve(root, readArg('--entry','dist/examples/frida-agent.js'));
const out=path.resolve(root, readArg('--out','dist/agents/native.js'));
const base=path.join(root,'dist');
const modules=new Map();
function key(file){return path.relative(base,file).replaceAll(path.sep,'/');}
function deps(js){
  const ast=ts.createSourceFile('bundle.js',js,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const items=[];
  function visit(node){
    if(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text==='require' &&
      node.arguments.length===1 && ts.isStringLiteralLike(node.arguments[0])) items.push(node.arguments[0].text);
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return items;
}
function collect(file){
  if(!file.startsWith(base+path.sep))throw new Error(`Agent dependency is outside dist: ${file}`);
  if(modules.has(key(file)))return;
  const js=fs.readFileSync(file,'utf8');
  modules.set(key(file),js);
  for(const request of deps(js)){
    if(!request.startsWith('.'))throw new Error(`External Node dependency ${request} from ${file}; unsupported in Frida`);
    const raw=path.resolve(path.dirname(file),request);
    const target=fs.existsSync(raw+'.js')?raw+'.js':fs.existsSync(path.join(raw,'index.js'))?path.join(raw,'index.js'):raw;
    collect(target);
  }
}
collect(entry);
const names=[...modules.keys()].sort();
const chunks=names.map(name=>`${JSON.stringify(name)}: function(module, exports, require) {\n${modules.get(name)}\n}`);
const bundle=`/* Nexus Native Frida standalone agent. Generated from CommonJS build; no Node require. */\n`+
`(function(){\n'use strict';\nconst factories = {\n${chunks.join(',\n')}\n};\nconst cache = Object.create(null);\n`+
`function resolve(parent, request){\n  if(request[0]!=='.') throw new Error('Node dependency forbidden in Frida: '+request);\n`+
`  const parts=parent.split('/');parts.pop();\n`+
`  for(const part of request.split('/')){if(part==='.'||!part)continue;if(part==='..')parts.pop();else parts.push(part);}\n`+
`  let name=parts.join('/');if(factories[name+'.js'])return name+'.js';if(factories[name+'/index.js'])return name+'/index.js';return name;\n}\n`+
`function load(name){if(cache[name])return cache[name].exports;const factory=factories[name];\n`+
`  if(!factory)throw new Error('Module missing from Frida bundle: '+name);\n`+
`  const module={exports:{}};cache[name]=module;factory(module,module.exports,request=>load(resolve(name,request)));return module.exports;\n}\n`+
`load(${JSON.stringify(key(entry))});\n})();\n`;
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,bundle);
console.log(`PASS Native Frida agent bundle ${path.relative(root,out)}, ${modules.size} modules, ${Buffer.byteLength(bundle)} bytes; real Gadget NOT RUN`);
// API callers may use a different entry importing java or il2cpp explicitly.
