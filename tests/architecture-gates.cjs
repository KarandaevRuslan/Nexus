#!/usr/bin/env node
'use strict';
/** Ensure a forbidden edge and an executable import cycle both fail the gate.
 * Test-created files are reliably deleted after each subprocess.
 */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),src=path.join(root,'src');
const checker=path.join(root,'scripts/check-architecture.cjs');
const run=()=>cp.spawnSync(process.execPath,[checker],{cwd:root,encoding:'utf8'});
let count=0;
function violation(paths,expected){
  const names=Object.keys(paths);
  try{
    for(const [name,code] of Object.entries(paths)){
      const file=path.join(src,name);fs.mkdirSync(path.dirname(file),{recursive:true});
      if(fs.existsSync(file))throw new Error('Cannot overwrite project module '+name);
      fs.writeFileSync(file,code);
    }
    const result=run();
    if(result.status===0||!((result.stdout||'')+(result.stderr||'')).includes(expected)){
      throw new Error(`Checker missed ${expected} (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    count++;
  }finally{for(const name of names)fs.rmSync(path.join(src,name),{force:true});}
}
violation({'core/state/__forbidden-type-test.ts': 'import type { Scheduler } from "../scheduling/scheduler"; export type T = Scheduler;\n'},'New/forbidden subsystem');
violation({'core/scheduling/__forbidden-value-test.ts': 'import { Dispatcher } from "../dispatcher"; export const D=Dispatcher;\n'},'Scheduler imports Dispatcher runtime');
violation({'frida/java/__forbidden-il2cpp-test.ts': 'import type { Il2CppBridgeLike } from "../il2cpp/types"; export type Bad = Il2CppBridgeLike;\n'},'New/forbidden subsystem');
violation({'core/state/__cycle-a-test.ts':'import { b } from "./__cycle-b-test"; export const a = () => b();\n',
 'core/state/__cycle-b-test.ts':'import { a } from "./__cycle-a-test"; export const b = () => a();\n'},'Runtime import cycle');
if(run().status!==0)throw new Error('Normal project must pass architecture check');
console.log(`PASS ${count} architecture-negative gates (type, value, bridge, runtime cycle), clean tree remains allowed`);
