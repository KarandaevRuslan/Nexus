#!/usr/bin/env node
'use strict';
/** Alternative deterministic differential corpus: 250 seeded + 260 focused.
 * This does NOT claim to reproduce the audit author's unavailable regression kit.
 * Usage: node scripts/differential-probe.cjs /path/to/project [seedCount=50]
 */
const path=require('node:path');
const root=path.resolve(process.argv[2]||'.');
const {Dispatcher,Handler}=require(path.join(root,'dist/src/core/index.js'));
const count=Number(process.argv[3]||50);
function r(seed){let value=seed>>>0;return()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value%100;};}
const read=(d,s)=>d.inline(ctx=>ctx.read(s));
const make=(run,when)=>new class extends Handler{run(ctx){return run(ctx)}when(ctx){return when?when(ctx):true}};
const output=[];
for(let variant=0;variant<5;variant++)for(let seed=1;seed<=count;seed++){
  const rng=r(seed*9827+variant),d=new Dispatcher();let entry;
  if(variant===0){ // committed updates preserve versions and stable values
    const s=d.store({n:rng(),x:[rng()]});
    for(let i=0;i<4;i++){const n=rng();d.inline(ctx=>ctx.update(s,v=>({n:v.n+n,x:[...v.x,n]})));}
    entry=[read(d,s),d.currentRevision];
  }else if(variant===1){ // no-op, forced touches, and read-only snapshots
    const s=d.store(rng()),seen=[];
    d.register(make(ctx=>seen.push([ctx.change(s)?.kind,ctx.before.read(s),ctx.after.read(s)])),{on:{any:[s]},execution:'inline'});
    for(let i=0;i<4;i++){const value=read(d,s);d.inline(ctx=>ctx.set(s,i%2?value:rng(),{record:i%3===0?'always':'changed'}));}
    entry=[seen,read(d,s),d.currentRevision];
  }else if(variant===2){ // Event each delivery, immutable payloads, emitted order
    const event=d.event(),seen=[];
    d.register(make(ctx=>seen.push(ctx.event(event)?.value)),{on:{any:[event]},delivery:'each',execution:'deferred'});
    const values=Array.from({length:6},()=>rng());
    d.inline(ctx=>{for(const v of values)ctx.emit(event,{v});});
    d.flush();entry=[seen,d.currentRevision];
  }else if(variant===3){ // Scope ownership and LIFO cleanup
    const a=d.scope(),b=a.child(),s=a.store(rng()),seq=[];
    a.cleanup(()=>seq.push('a'+seed));b.cleanup(()=>seq.push('b'+seed));
    const val=read(d,s);a.dispose();entry=[seq,a.active,b.active,val];
  }else { // failed speculative callback leaves no committed staged event/write
    const s=d.store(rng()),event=d.event(),seen=[];
    d.register(make(ctx=>seen.push(ctx.event(event).value)),{on:{any:[event]},execution:'inline'});
    try{d.inline(ctx=>{ctx.set(s,rng());ctx.emit(event,rng());throw new Error('cancel');});}catch(e){seen.push(e.message);}
    entry=[read(d,s),seen,d.currentRevision];
  }
  output.push({suite:'seeded-'+variant,seed,value:entry});
}
for(let variant=0;variant<5;variant++)for(let seed=1;seed<=52;seed++){
  const rng=r(seed*7111+variant),d=new Dispatcher();let entry;
  if(variant===0){ // bounded delivery admission before publication
    const s=d.store(0),event=d.event(),seen=[];
    d.register(make(ctx=>seen.push(ctx.event(event)?.value)),{on:{any:[event]},delivery:'each',buffer:{capacity:2,overflow:'reject'}});
    let fault='';try{d.inline(ctx=>{ctx.set(s,rng());for(let i=0;i<3;i++)ctx.emit(event,i);});}catch(e){fault=e.name;}
    d.flush();entry=[read(d,s),fault,seen,d.currentRevision];
  }else if(variant===1){ // skip on conflicts must discard independent wave members
    const trigger=d.store(0),a=d.store(0),b=d.store(0);
    const x=d.register(make(ctx=>ctx.set(a,rng())),{on:{any:[trigger]},execution:'inline'});
    const y=d.register(make(ctx=>ctx.set(a,rng())),{on:{any:[trigger]},execution:'inline'});
    d.register(make(ctx=>ctx.set(b,rng())),{on:{any:[trigger]},execution:'inline'});
    d.conflicts.add({store:a,between:[x,y],resolve:{strategy:'skip'}});
    d.inline(ctx=>ctx.set(trigger,seed));entry=[read(d,a),read(d,b),d.currentRevision];
  }else if(variant===2){ // ordered atomic sequence replay
    const trigger=d.store(0),n=d.store(0),trace=[];
    const x=d.register(make(ctx=>{trace.push(ctx.read(n));ctx.set(n,seed)}),{on:{any:[trigger]},execution:'inline'});
    const y=d.register(make(ctx=>{trace.push(ctx.read(n));ctx.update(n,v=>v+rng())}),{on:{any:[trigger]},execution:'inline'});
    d.conflicts.add({store:n,between:[x,y],resolve:{strategy:'sequence',order:[x,y]}});
    d.inline(ctx=>ctx.set(trigger,seed));entry=[trace,read(d,n),d.currentRevision];
  }else if(variant===3){ // read-only when view and effect origin / postcommit order
    const trigger=d.store(0),seen=[];
    const handler=make(ctx=>{seen.push('run:'+ctx.read(trigger));ctx.effect(()=>seen.push('effect:'+seed));},ctx=>ctx.read(trigger)>0);
    d.register(handler,{on:{any:[trigger]},execution:'inline'});
    d.inline(ctx=>ctx.set(trigger,seed));entry=[seen,d.currentRevision];
  }else{ // event latest coalesces while deferred
    const ev=d.event(),seen=[];
    d.register(make(ctx=>seen.push(ctx.event(ev)?.value)),{on:{any:[ev]},delivery:'latest',execution:'deferred'});
    for(let i=0;i<5;i++)d.inline(ctx=>ctx.emit(ev,seed+i+rng()));
    d.flush();entry=[seen,d.currentRevision];
  }
  output.push({suite:'focused-'+variant,seed,value:entry});
}
console.log(JSON.stringify(output));
