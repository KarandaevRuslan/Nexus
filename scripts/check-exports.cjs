#!/usr/bin/env node
'use strict';
/** Golden API names from the original nexus-v0.1.18 source distribution.
 * Checks runtime shape and ALL TypeScript type-only exports independently.
 */
const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const root=path.resolve(__dirname,'..');const golden=require('./api-golden.json');
const configPath=path.join(root,'tsconfig.json');
const raw=ts.readConfigFile(configPath,ts.sys.readFile);
if(raw.error)throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText,'\n'));
const cfg=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const program=ts.createProgram(cfg.fileNames,cfg.options);
const checker=program.getTypeChecker();
let failures=0;
function same(name, got, expected){
  if(JSON.stringify(got)!==JSON.stringify(expected)){
    failures++;console.error(`FAIL ${name}: got ${JSON.stringify(got)}; expected ${JSON.stringify(expected)}`);
  }
}
for(const [entry, expected] of Object.entries(golden)){
  const js=path.resolve(root,'dist',entry+'.js');
  const values=Object.keys(require(js)).sort();
  same(`${entry} runtime values`,values,expected.values);
  const file=path.join(root,entry.replace(/^dist\//,'')+'.ts');
  // Golden keys are "src/..."; use the source path directly.
  const actual=program.getSourceFile(path.join(root,entry+'.ts'));
  if(!actual){failures++;console.error('FAIL missing source entry '+entry);continue;}
  const sym=checker.getSymbolAtLocation(actual);
  const names=checker.getExportsOfModule(sym).filter(e=>{
    const aliased=(e.flags&ts.SymbolFlags.Alias)?checker.getAliasedSymbol(e):e;
    return Boolean(aliased.flags&ts.SymbolFlags.Type);
  }).map(e=>e.name).sort();
  same(`${entry} type exports`,names,expected.types);
}
if(failures)process.exitCode=1;
else console.log('PASS Core 14 / Frida 5 runtime exports and all declared type names match original v0.1.18 baseline (root and compatibility entrypoints)');
