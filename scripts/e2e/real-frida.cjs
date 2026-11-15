#!/usr/bin/env node
'use strict';
/** Explicit, opt-in real-runtime smoke using npm-installed `frida` host tools.
 * It does NOT install arbitrary native hooks and never runs implicitly in CI.
 * Usage: FRIDA_PID=<test process> FRIDA_DEVICE=usb node scripts/e2e/real-frida.cjs
 */
const fs=require('node:fs'),path=require('node:path');
async function main(){
  if(!process.env.FRIDA_PID||!/^\d+$/.test(process.env.FRIDA_PID))throw new Error('Set numeric FRIDA_PID of an owned test process');
  let frida;
  try{frida=require('frida');}catch{throw new Error('Install Frida host tools separately: npm install --no-save frida');}
  const device=process.env.FRIDA_DEVICE==='usb'?await frida.getUsbDevice():process.env.FRIDA_DEVICE==='remote'?await frida.getRemoteDevice():await frida.getLocalDevice();
  const session=await device.attach(Number(process.env.FRIDA_PID));
  try{
    const source=fs.readFileSync(path.join(__dirname,'../../dist/agents/smoke.js'),'utf8');
    const script=await session.createScript(source);
    let finish, rejectWait;
    const acknowledged=new Promise((resolve,reject)=>{finish=resolve;rejectWait=reject;});
    const timeout=setTimeout(()=>rejectWait(new Error('No nexus-smoke-v1 message within 10 seconds')),10_000);
    script.message.connect(message=>{
      console.log('Frida:',JSON.stringify(message));
      if(message.type==='error')rejectWait(new Error(message.stack||message.description||'Script exception'));
      if(message.type==='send'&&message.payload?.protocol==='nexus-smoke-v1'&&message.payload.value===1)finish();
    });
    try{await script.load();await acknowledged;}finally{clearTimeout(timeout);await script.unload();}
    console.log('PASS real Frida Core loading smoke (NOT Java/IL2CPP/hook ABI compatibility)');
  }finally{await session.detach();}
}
main().catch(e=>{console.error('FAIL real Frida smoke:',e);process.exitCode=1;});
