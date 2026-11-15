#!/usr/bin/env node
'use strict';
/** Bootstrap and first-initial Handler contract tests, strict-rejection safe. */
const assert=require('node:assert/strict');const path=require('node:path');
const root=path.resolve(__dirname,'..'),{Dispatcher,Handler}=require(path.join(root,'dist/src/core/index.js'));
const {Scheduler}=require(path.join(root,'dist/src/core/scheduling/scheduler.js'));
const {TransactionGuard}=require(path.join(root,'dist/src/core/transactions/transaction-guard.js'));
const {WorkQueue}=require(path.join(root,'dist/src/core/scheduling/work-queue.js'));
const limits={maxInlineWaves:32,maxWavesPerTurn:32,maxCommandsBeforeDeferred:16,maxCausalWaves:256};
const sched=new Scheduler(new WorkQueue(),new TransactionGuard(),{report(e){throw e;}},limits);
assert.throws(()=>sched.flushInline(),/before executor bootstrap/);
assert.throws(()=>sched.connect({}),/port is incomplete/);
assert.throws(()=>sched.flushInline(),/before executor bootstrap/);
sched.connect({context(){throw new Error('unused')},commit(){},processNextGroup(){}});
assert.throws(()=>sched.connect({}),/already connected/);
const d=new Dispatcher();const s=d.store(0);let runs=0;
class Start extends Handler {run(ctx){runs++;ctx.update(s,x=>x+1);}}
const handler=new Start();const reg=d.register(handler,{initial:true,execution:'inline'});
assert.equal(runs,1);assert.equal(d.inline(ctx=>ctx.read(s)),1);
reg.dispose();
let attempt=0,dispose=0;
class FailsOnce extends Handler {
  run(){if(++attempt===1)throw new Error('initial failure');}
  onDispose(){dispose++;}
}
const flaky=new FailsOnce();
assert.throws(()=>d.register(flaky,{initial:true,execution:'inline'}),/initial failure/);
assert.equal(dispose,1);
const retry=d.register(flaky,{initial:true,execution:'inline'});
assert.equal(attempt,2);retry.dispose();assert.equal(dispose,2);
let reported=0;
const originalError=console.error;console.error=()=>{reported++;};
try{
  const error=new Dispatcher({onError(){throw new Error('reporter failure')}});
  const cause=error.store(0);
  error.inline(ctx=>{ctx.effect(()=>{throw new Error('effect failed')});ctx.set(cause,4);});
  assert.equal(error.inline(ctx=>ctx.read(cause)),4);
}finally{console.error=originalError;}
assert.equal(reported,1);
console.log('PASS bootstrap binding, initial Handler, failed install rollback and retry, post-commit reporter isolation');
