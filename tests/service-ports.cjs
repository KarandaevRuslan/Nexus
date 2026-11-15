#!/usr/bin/env node
'use strict';
/** Isolated owner/port checks: no constructed Dispatcher or Frida Bridge. */
const assert=require('node:assert/strict'),path=require('node:path');const root=path.resolve(__dirname,'..');
const {TransactionEngine}=require(path.join(root,'dist/src/core/transactions/transaction-engine.js'));
const {TransactionGuard}=require(path.join(root,'dist/src/core/transactions/transaction-guard.js'));
const {RegistrationManager}=require(path.join(root,'dist/src/core/reactions/registration-manager.js'));
const {Handler}=require(path.join(root,'dist/src/core/index.js'));
const log=[];const guard=new TransactionGuard();const cause={id:3,root(){return this}};
const state={currentRevision:0,snapshot(){return {revision:this.currentRevision,cells:new Map()}},
 commit(_ctx,preflight){
  log.push('preflight');const frame={changes:[{store:{id:1},kind:'changed'}],preImage:new Map(),beforeRevision:this.currentRevision};
  preflight(frame);this.currentRevision++;log.push('publish-state');return frame;
 }};
const publication={previewStoreWake(){return new Set()},eventWake(){return []},
 publish(_frame,_snapshot,_cause,enqueue){log.push('publish-subscribers');},publishEvent(){throw new Error('unexpected')} };
const scheduler={newCause(){return cause},enqueue(){throw new Error('unexpected')},
 withEffectCause(_cause,action){return action()}};
const createContext=()=>({});const reporter={report(e){throw e}};
const engine=new TransactionEngine(createContext,state,publication,{assertCapacity(){}},guard,scheduler,reporter,()=>{},()=>{});
const ctx={_signals(){return []},_effects(){return [{callback(){guard.assertReady('effect');log.push('effect')}}]},_close(){log.push('close-context')}};
const commit=engine.commit([ctx]);
assert.equal(commit.revision,1);
assert.deepEqual(log,['preflight','publish-state','publish-subscribers','close-context','effect']);
log.length=0;state.commit=(_ctx,preflight)=>{log.push('preflight');preflight({changes:[],beforeRevision:0,preImage:new Map()});throw Error('atomic preflight failure')};
assert.throws(()=>engine.commit([ctx]),/atomic preflight failure/);
assert.deepEqual(log,['preflight']);guard.assertReady('after-failure');
// The registration lifecycle can also be driven with narrow fake owned instances.
const owner={},tracked=[];
const subs={register(r){tracked.push('register:'+r.id)},unregister(r){tracked.push('unregister:'+r.id)}};
const work={cancel(){tracked.push('cancel')}};
const scheduling={newCause(){return cause},activeEffectCause:undefined,
 enqueue(){tracked.push('enqueue')},flushInline(){tracked.push('flush-inline')},settleWaiters(){tracked.push('settle')}};
const manager=new RegistrationManager(owner,{assertRegistered(){},snapshot(){return {revision:0,cells:new Map()}}},subs,{unregister(){}},work,
 new TransactionGuard(),scheduling,()=>{});
class H extends Handler { onDispose(){tracked.push('dispose')}}
const registration=manager.register(new H(),{initial:true,execution:'inline'});
assert.equal(registration.active,true);
manager.unregister(registration);
assert.deepEqual(tracked,['register:1','enqueue','flush-inline','unregister:1','cancel','settle','dispose']);
console.log('PASS atomic publisher and registration lifecycle on narrow mock ports without Dispatcher composition');
