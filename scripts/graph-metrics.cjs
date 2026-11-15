#!/usr/bin/env node
'use strict';
/** Read-only import graph measurement for before/after architecture reports. */
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(process.argv[2]||path.resolve(__dirname,'..'));
const src=path.join(root,'src');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[])}
const files=walk(src),edges=[];
const moduleName=p=>path.relative(src,p).replaceAll(path.sep,'/');
const area=p=>{const rel=moduleName(p).split('/');return rel[0]==='core'?`core/${rel.length>2?rel[1]:'facade'}`:rel[0]==='frida'?`frida/${rel.length>2?rel[1]:'facade'}`:'entrypoint'};
for(const file of files){
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 for(const n of ast.statements){
  if(!ts.isImportDeclaration(n)&&!ts.isExportDeclaration(n))continue;
  if(!n.moduleSpecifier||!ts.isStringLiteralLike(n.moduleSpecifier)||!n.moduleSpecifier.text.startsWith('.'))continue;
  const guess=path.resolve(path.dirname(file),n.moduleSpecifier.text);
  const target=[guess,guess+'.ts',path.join(guess,'index.ts')].find(x=>fs.existsSync(x)&&x.endsWith('.ts'));
  if(!target)continue;
  const named=ts.isImportDeclaration(n)&&n.importClause?.namedBindings;
  const type=Boolean(n.isTypeOnly||(ts.isImportDeclaration(n)&&n.importClause?.isTypeOnly)||
    (named&&ts.isNamedImports(named)&&named.elements.length&&named.elements.every(e=>e.isTypeOnly)));
  edges.push({from:file,to:target,type:type?'type':'runtime'});
 }
}
function scc(includeTypes){const adj=new Map(files.map(x=>[x,[]]));for(const e of edges)if(includeTypes||e.type==='runtime')adj.get(e.from).push(e.to);const index=new Map(),low=new Map(),stack=[],member=new Set(),groups=[];let next=0;
 function visit(v){index.set(v,next);low.set(v,next++);stack.push(v);member.add(v);for(const w of adj.get(v)){if(!index.has(w)){visit(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(member.has(w))low.set(v,Math.min(low.get(v),index.get(w)));}if(low.get(v)===index.get(v)){const group=[];let w;do{w=stack.pop();member.delete(w);group.push(moduleName(w));}while(w!==v);if(group.length>1)groups.push(group.sort());}}
 for(const v of files)if(!index.has(v))visit(v);return groups;}
const groups={};
for(const e of edges){const k=`${area(e.from)} -> ${area(e.to)}`;groups[k]??={type:0,runtime:0};groups[k][e.type]++;}
console.log(JSON.stringify({files:files.length,edges:edges.length,runtime:edges.filter(e=>e.type==='runtime').length,
 type:edges.filter(e=>e.type==='type').length,runtimeCycles:scc(false),typeInclusiveSCCs:scc(true),groups:Object.fromEntries(Object.entries(groups).sort())},null,2));
