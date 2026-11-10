import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
const resolver=()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}});
async function fixture(run:(v:Vault)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-jobs-"));const v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A","id-A",0);v.replaceBinding("B","key-B","id-B",0);
  try{await run(v);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
test("jobs validate before accepting, preserve request IDs, execute once and isolate principals",()=>fixture(async v=>{
  let sent=0;
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch);
  const jobs=new Jobs(v,e,resolver,{autoStart:false});
  try{
    await assert.rejects(jobs.submit("A",{operation_id:"notAnOperation"}));
    const ack=await jobs.submit("A",{operation_id:"getServerVersion"});
    assert.equal(sent,0);assert.equal(jobs.get("A",ack.job_ref).state,"queued");
    assert.throws(()=>jobs.get("B",ack.job_ref));assert.throws(()=>jobs.cancel("B",ack.job_ref));
    jobs.start();await jobs.idle();
    const done=jobs.get("A",ack.job_ref);
    assert.equal(done.state,"completed");assert.equal(done.send_started,true);assert.equal(sent,1);
    assert.equal(done.request_id,ack.request_id);assert.equal(done.result.request_id,ack.request_id);
    assert.equal(jobs.recent("A")[0]!.job_ref,ack.job_ref);assert.deepEqual(jobs.recent("B"),[]);
    assert.ok(!JSON.stringify(done).includes("key-A"));
    v.replaceBinding("A","new-key","id-A",1);assert.equal(jobs.get("A",ack.job_ref).result,null);
  }finally{await jobs.close();}
}));
test("queued cancellation and credential updates never send old requests",()=>fixture(async v=>{
  let sent=0;const e=new Executor("http://immich/api",v,(async()=>{sent++;return new Response();}) as typeof fetch);
  const jobs=new Jobs(v,e,resolver,{autoStart:false});
  try{
    const cancel=await jobs.submit("A",{operation_id:"getServerVersion"});
    assert.equal(jobs.cancel("A",cancel.job_ref).state,"cancelled");
    const changed=await jobs.submit("A",{operation_id:"getServerVersion"});
    v.replaceBinding("A","new-key","id-A",1);
    jobs.start();await jobs.idle();assert.equal(sent,0);
    assert.equal(jobs.get("A",changed.job_ref).state,"cancelled");
  }finally{await jobs.close();}
}));
test("cancelling a sent request becomes outcome_unknown and does not replay",()=>fixture(async v=>{
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});let sent=0;
  const e=new Executor("http://immich/api",v,((_:any,init:any)=>new Promise((_resolve,reject)=>{
    sent++;started();init.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
  })) as typeof fetch);
  const jobs=new Jobs(v,e,resolver);
  try{
    const ack=await jobs.submit("A",{operation_id:"getServerVersion"});await ready;
    assert.equal(jobs.cancel("A",ack.job_ref).state,"cancel_requested");
    await jobs.idle();assert.equal(jobs.get("A",ack.job_ref).state,"outcome_unknown");assert.equal(sent,1);
  }finally{await jobs.close();}
  const reopened=new Jobs(v,e,resolver,{autoStart:false});
  assert.equal(reopened.recent("A")[0]!.state,"outcome_unknown");await reopened.close();assert.equal(sent,1);
}));
test("restart distinguishes unsent, sent and unsent cancellation without repeating effects",()=>fixture(async v=>{
  let sent=0;const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch);
  const old=new Jobs(v,e,resolver,{autoStart:false});
  const unsent=await old.submit("A",{operation_id:"getServerVersion"});
  const unknown=await old.submit("A",{operation_id:"getServerVersion"});
  const cancelled=await old.submit("A",{operation_id:"getServerVersion"});
  await old.close();
  v.db.prepare("UPDATE jobs SET state='running',sent=0 WHERE id=?").run(unsent.job_ref);
  v.db.prepare("UPDATE jobs SET state='running',sent=1 WHERE id=?").run(unknown.job_ref);
  v.db.prepare("UPDATE jobs SET state='cancel_requested',sent=0 WHERE id=?").run(cancelled.job_ref);
  const next=new Jobs(v,e,resolver,{autoStart:false});
  try{
    assert.equal(next.get("A",unknown.job_ref).state,"outcome_unknown");
    assert.equal(next.get("A",cancelled.job_ref).state,"cancelled");
    next.start();await next.idle();
    assert.equal(next.get("A",unsent.job_ref).state,"completed");assert.equal(sent,1);
  }finally{await next.close();}
}));
test("queue enforces pending quota and per-principal concurrency without starving B",()=>fixture(async v=>{
  const seen:string[]=[];let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});
  const e=new Executor("http://immich/api",v,(async(_:any,init:any)=>{
    const key=init.headers.get("x-api-key");seen.push(key);
    if(key==="key-A")await wait;
    return Response.json({major:3,minor:3,patch:5,prerelease:null});
  }) as typeof fetch);
  const jobs=new Jobs(v,e,resolver,{autoStart:false,concurrency:2,perPrincipalConcurrency:1,maxPendingPerPrincipal:2});
  try{
    await jobs.submit("A",{operation_id:"getServerVersion"});await jobs.submit("A",{operation_id:"getServerVersion"});
    await assert.rejects(jobs.submit("A",{operation_id:"getServerVersion"}),{code:"job_quota"});
    await jobs.submit("B",{operation_id:"getServerVersion"});jobs.start();
    for(let i=0;seen.length<2&&i<100;i++)await new Promise(r=>setTimeout(r,5));
    assert.deepEqual(seen,["key-A","key-B"]);release();await jobs.idle();assert.equal(seen.length,3);
  }finally{release();await jobs.close();}
}));

test("queued requests survive closing and reopening the actual SQLite database",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-job-reopen-")),key=randomBytes(32);
  let v=new Vault(dir,key,"test"),jobs:Jobs|undefined;
  try{
    v.replaceBinding("A","key-A","id-A",0);
    let sends=0;
    const http=(async()=>{sends++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch;
    jobs=new Jobs(v,new Executor("http://immich/api",v,http),resolver,{autoStart:false});
    const ack=await jobs.submit("A",{operation_id:"getServerVersion"});
    await jobs.close();v.close();
    v=new Vault(dir,key,"test");
    jobs=new Jobs(v,new Executor("http://immich/api",v,http),resolver,{autoStart:false});
    assert.equal(jobs.recent("A")[0]!.request_id,ack.request_id);
    assert.equal(jobs.get("A",ack.job_ref).state,"queued");
    jobs.start();await jobs.idle();
    assert.equal(jobs.get("A",ack.job_ref).state,"completed");assert.equal(sends,1);
  }finally{await jobs?.close();v.close();await rm(dir,{recursive:true,force:true});}
});

test("a second queue cannot reinterpret live work on the same vault as crashed",()=>fixture(async v=>{
  const e=new Executor("http://immich/api",v,(async()=>new Response()) as typeof fetch);
  const first=new Jobs(v,e,resolver,{autoStart:false});
  try{
    const ack=await first.submit("A",{operation_id:"getServerVersion"});
    assert.throws(()=>new Jobs(v,e,resolver,{autoStart:false}),{code:"queue_owned"});
    assert.equal(first.get("A",ack.job_ref).state,"queued");
  }finally{await first.close();}
  const next=new Jobs(v,e,resolver,{autoStart:false});await next.close();
}));

test("an unsent job recovered after restart clears the previous diagnostic when it completes",()=>fixture(async v=>{
  let sent=0;const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch);
  const previous=new Jobs(v,e,resolver,{autoStart:false}),ack=await previous.submit("A",{operation_id:"getServerVersion"});
  const record=v.get("A",ack.job_ref,"job");record.diagnostic={code:"job_failed",message:"A prior unsent attempt failed"};
  v.put("A","job",record,Date.now()+86400000,ack.job_ref);v.db.prepare("UPDATE jobs SET state='running',sent=0 WHERE id=?").run(ack.job_ref);await previous.close();
  const recovered=new Jobs(v,e,resolver);
  try{await recovered.idle();const result=recovered.get("A",ack.job_ref);assert.equal(result.state,"completed");assert.equal(sent,1);assert.equal(result.diagnostic,null);}
  finally{await recovered.close();await e.close();}
}));
