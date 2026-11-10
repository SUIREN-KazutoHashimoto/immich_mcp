import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { operation } from "../src/registry.js";
import { sample,uuid } from "./fixtures.js";
const resolver=()=>({secret:async()=>{throw Error();},file:async()=>{throw Error();}});
test("cleanup preserves a genuinely running job until its single request completes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-live-cleanup-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);let entered!:()=>void,release!:()=>void,sent=0;
  const started=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
  const e=new Executor("http://immich/api",v,(async()=>{sent++;entered();await hold;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch);
  const jobs=new Jobs(v,e,resolver,{autoStart:false});
  try{
    const ack=await jobs.submit("A",{operation_id:"getServerVersion"});jobs.start();await started;
    v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(ack.job_ref);
    const report=await v.cleanup();assert.ok(report.active_skipped>=1);
    assert.equal(v.db.prepare("SELECT state FROM jobs WHERE id=?").get(ack.job_ref)!.state,"running");
    release();await jobs.idle();assert.equal(jobs.get("A",ack.job_ref).state,"completed");assert.equal(sent,1);
  }finally{release();await jobs.close();v.close();await rm(dir,{recursive:true,force:true});}
});
test("job polling cannot bypass result retention or persist a duplicate display body",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-job-retention-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);
  const schema=operation("getMyUser").definition.responses["200"].content["application/json"].schema;
  const value={...sample(schema),name:"RETAINED-BUSINESS-CANARY"};
  const e=new Executor("http://immich/api",v,(async()=>Response.json(value)) as typeof fetch);
  const jobs=new Jobs(v,e,resolver,{autoStart:false});
  try{
    const ack=await jobs.submit("A",{operation_id:"getMyUser"});jobs.start();await jobs.idle();
    const first=jobs.get("A",ack.job_ref);assert.equal(first.result.data.name,"RETAINED-BUSINESS-CANARY");
    const stored=v.get("A",ack.job_ref,"job");assert.equal(stored.result.data,null);
    v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(first.result.result_ref);
    stored.result.data={name:"LEGACY-DUPLICATE-CANARY"};v.put("A","job",stored,Date.now()+10000,ack.job_ref);
    const ended=jobs.get("A",ack.job_ref);assert.equal(ended.state,"completed");assert.equal(ended.result,null);
    assert.equal(ended.diagnostic.code,"result_unavailable");assert.ok(!JSON.stringify(ended).includes("CANARY"));
  }finally{await jobs.close();v.close();await rm(dir,{recursive:true,force:true});}
});
