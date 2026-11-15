#!/usr/bin/env node
'use strict';
/** A parsing/load smoke on simulated globals, NOT a genuine Frida runtime test. */
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const bundle=fs.readFileSync(path.join(__dirname,'../dist/agents/native.js'),'utf8');
let subscribed=0;
const globals={
  Process:{attachModuleObserver(observer){
    if(typeof observer.onAdded!=='function'||typeof observer.onRemoved!=='function')throw new Error('Invalid Frida observer callbacks');
    subscribed++;return{detach(){}};
  }},
  Interceptor:{attach(){throw new Error('Interceptor not expected in load-only smoke')}},
  ptr(){throw new Error('ptr not expected in load-only smoke')},
  NativeFunction:function(){throw new Error('NativeFunction not expected in load-only smoke')},
  console, setTimeout, clearTimeout,
};
// Node require/module/process are intentionally absent.
vm.runInNewContext(bundle, globals, {filename:'native-agent.js',timeout:3000});
if(subscribed!==1)throw new Error(`Expected 1 module observer, got ${subscribed}`);
if(bundle.includes('"java/hooks.js":')||bundle.includes('"il2cpp/hooks.js":'))throw new Error('Optional bridges bundled by default');
const messages=[];
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/agents/smoke.js'),'utf8'), {...globals, send: value => messages.push(value)}, {filename:'safe-smoke.js',timeout:3000});
if(messages.length!==1 || messages[0].protocol!=='nexus-smoke-v1' || messages[0].value!==1)throw new Error('Safe Core smoke payload mismatch');
console.log('PASS Native + safe Core agent load in mocked Frida globals; real Gadget/ART/IL2CPP/ABI: NOT RUN');
