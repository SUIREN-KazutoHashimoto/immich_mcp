import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,createHash } from "node:crypto";
import { Vault } from "../src/vault.js";
import { Staging } from "../src/staging.js";
import { Uploads } from "../src/uploads.js";
import { Jobs } from "../src/jobs.js";
import { Executor } from "../src/executor.js";
import { DownloadPolicy } from "../src/download.js";
import { registry } from "../src/registry.js";
import { JsonTree } from "../src/json-tree.js";
import { sample,uuid } from "./fixtures.js";
const src=(b:Uint8Array)=>(async function*(){yield b;})(),sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
test("pre-ledger uploads and accepted jobs are backfilled without losing their data or capacity promises",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-ledger-migration-")),key=randomBytes(32),limits={quotaBytes:2*1024*1024,globalQuotaBytes:4*1024*1024};
  let v=new Vault(dir,key,"test",undefined,limits);
  try{
    v.replaceBinding("A","key-A",uuid,0);
    const u=new Uploads(new Staging(v,new DownloadPolicy([]),{maxFileBytes:1000,quotaBytes:200000}),4),bytes=Buffer.from("abcdefgh");
    const upload=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8});await u.append("A",upload.upload_ref,0,sha(bytes.subarray(0,4)),src(bytes.subarray(0,4)));
    const executor=new Executor("http://immich/api",v),resolver=()=>({secret:async()=>{throw Error();},file:async()=>{throw Error();}});
    const jobs=new Jobs(v,executor,resolver,{autoStart:false}),ack=await jobs.submit("A",{operation_id:"getServerVersion"});await jobs.close();
    // Remove only this feature's ledger to reproduce the prior persisted schema.
    v.db.exec("DROP TRIGGER records_quota_insert;DROP TRIGGER records_quota_update;DROP TRIGGER records_quota_delete;DROP TABLE raw_objects;DROP TABLE storage_reservations;DROP TABLE storage_totals;DROP TABLE storage_global;DROP TABLE storage_schema;");
    v.close();v=new Vault(dir,key,"test",undefined,limits);
    assert.ok(v.storage.reservation("A",upload.upload_ref));assert.equal(v.storage.reservation("A","status_"+ack.job_ref)!.remaining,65536);
    const resumed=new Uploads(new Staging(v,new DownloadPolicy([]),{maxFileBytes:1000,quotaBytes:200000}),4);
    await resumed.append("A",upload.upload_ref,1,sha(bytes.subarray(4)),src(bytes.subarray(4)));
    const file=await resumed.complete("A",upload.upload_ref);assert.equal(file.sha256,sha(bytes));
    let sent=0;
    const resumedJobs=new Jobs(v,new Executor("http://immich/api",v,(async()=>{sent++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch,1024*1024,131072),resolver,{autoStart:false});
    try{resumedJobs.start();await resumedJobs.idle();assert.equal(resumedJobs.get("A",ack.job_ref).state,"completed",JSON.stringify(resumedJobs.get("A",ack.job_ref).diagnostic));assert.equal(sent,1);}finally{await resumedJobs.close();}
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
    assert.ok(v.storage.usage("A").used_bytes<limits.quotaBytes);
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
test("a lowered quota keeps existing encrypted data readable and recovers after expiry cleanup",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-ledger-lowered-")),key=randomBytes(32);
  let v=new Vault(dir,key,"test");
  try{
    const ref=v.put("A","secret",{value:"PRESERVED-CANARY".repeat(1000)});v.close();
    v=new Vault(dir,key,"test",undefined,{quotaBytes:2048,globalQuotaBytes:4096});
    assert.ok(v.get("A",ref,"secret").value.startsWith("PRESERVED-CANARY"));assert.equal(v.storage.usage("A").available_bytes,0);
    assert.throws(()=>v.put("A","secret",{value:"new"}),{code:"storage_quota"});
    v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(ref);await v.cleanup();
    v.put("A","secret",{value:"allowed after cleanup"});assert.ok(v.storage.usage("A").available_bytes>0);
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
test("bounded incremental raw reservations leave room for a valid large JSON secret",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-ledger-secret-")),v=new Vault(dir,randomBytes(32),"test",":memory:",{quotaBytes:2*1024*1024,globalQuotaBytes:4*1024*1024});
  try{
    v.replaceBinding("A","key-A",uuid,0);let sent=0;
    const body={...sample(registry.schemas.ApiKeyCreateResponseDto!),secret:"k".repeat(500000)};
    const e=new Executor("http://immich/api",v,(async()=>{sent++;return new Response(JSON.stringify(body),{status:201,headers:{"content-type":"Application/JSON"}});}) as typeof fetch,1024*1024,256);
    const result=await e.call("A",{operation_id:"createApiKey",body:sample(registry.schemas.ApiKeyCreateDto!)});
    assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));assert.equal(sent,1);
    const saved=v.get("A",result.result_ref!,"result"),tree=new JsonTree(v,"A",undefined,saved.projection.tree_id);
    const display=tree.value(saved.projection.root,65536);
    assert.equal(v.get("A",display.secret.secret_ref,"secret").value.length,500000);
    assert.ok(!JSON.stringify(result).includes("k".repeat(30)));assert.ok(v.storage.usage("A").used_bytes<2*1024*1024);
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
