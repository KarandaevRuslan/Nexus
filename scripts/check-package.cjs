#!/usr/bin/env node
'use strict';
/** Smoke the generated CJS package layout and declarations, not unpublished npm registry. */
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..');const pkg=require('../package.json');
if(pkg.name!=='nexus')throw new Error('Expected package name nexus');
if(pkg.private!==true||pkg.type!=='commonjs')throw new Error('GitHub release package must remain private CommonJS');
for(const entry of Object.values(pkg.exports)){
  if(!entry.require||!entry.types)throw new Error('An export has no require/types path');
  for(const name of [entry.require,entry.types]){
    if(!fs.existsSync(path.join(root,name)))throw new Error(`Missing built package member ${name}`);
  }
}
if(pkg.main!==pkg.exports['.'].require||pkg.types!==pkg.exports['.'].types)throw new Error('Package root metadata disagrees');
const namespace=require(root);
const core=require(path.join(root,'dist/src/core/index.js'));
const frida=require(path.join(root,'dist/src/frida/index.js'));
if(namespace.Dispatcher!==core.Dispatcher||namespace.attachHook!==frida.attachHook)throw new Error('Built public entrypoint differs');
if(require('nexus/core').Dispatcher!==core.Dispatcher || require('nexus/frida').attachJavaHook!==frida.attachJavaHook)throw new Error('Package self-reference exports broken');
const agent=path.join(root,'dist/agents/native.js');
if(!fs.existsSync(agent))throw new Error('Frida bundle missing; build:agent first');
// Compile an actual TypeScript consumer against generated .d.ts files in an
// isolated temp file; no direct implementation import is used.
const smoke=path.join(root,'dist/.types-smoke.ts');
const consumer=`import { Dispatcher, Handler, type Context, type Store, type ManagedCall, attachJavaHook } from './src/index';\n`+
`import type { JavaBridgeLike } from './src/frida/index';\n`+
`const d = new Dispatcher(); const s: Store<number> = d.store(0);\n`+
`class H extends Handler { override run(ctx: Context): void { ctx.set(s, 1); ctx.effect(() => {}); } }\n`+
`d.register(new H(), { on: { any: [s] }, execution: 'deferred' });\n`+
`declare const bridge: JavaBridgeLike; declare const call: ManagedCall<[number], number>;\n`+
`void [bridge, call, attachJavaHook];\n`;
try{
 fs.writeFileSync(smoke,consumer);
 const program=ts.createProgram([smoke],{strict:true,noEmit:true,module:ts.ModuleKind.CommonJS,
  moduleResolution:ts.ModuleResolutionKind.Node10,target:ts.ScriptTarget.ES2022,
  skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts']});
 const errors=ts.getPreEmitDiagnostics(program);
 if(errors.length)throw new Error('Built declarations do not compile:\n'+ts.formatDiagnosticsWithColorAndContext(errors,{
  getCurrentDirectory:()=>root, getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
} finally {fs.rmSync(smoke,{force:true});}
console.log('PASS CJS root/core/frida require, package self-references, .d.ts consumer, Native agent artifact');
