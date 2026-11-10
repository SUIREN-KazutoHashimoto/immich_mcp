import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,readdir,stat,unlink,mkdir,rmdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Vault } from "../src/vault.js";
import { Staging } from "../src/staging.js";
import { Uploads } from "../src/uploads.js";
import { DownloadPolicy } from "../src/download.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { uuid } from "./fixtures.js";
const source=(b:Uint8Array)=>(async function*(){yield b;})(),sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
async function fixture(run:(v:Vault,dir:string)=>Promise<void>,quota=2*1024*1024,global=4*1024*1024){
  const dir=await mkdtemp(join(tmpdir(),"immich-quota-")),v=new Vault(dir,randomBytes(32),"test",":memory:",{quotaBytes:quota,globalQuotaBytes:global});
  try{await run(v,dir);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
async function check(v:Vault,principal:string){
  const records=Number((v.db.prepare("SELECT COALESCE(SUM(length(payload)),0) n FROM records WHERE principal=?").get(principal) as any).n);
  const reservations=Number((v.db.prepare("SELECT COALESCE(SUM(remaining),0) n FROM storage_reservations WHERE principal=?").get(principal) as any).n);
  let objects=0;
  for(const row of v.db.prepare("SELECT id,size FROM raw_objects WHERE principal=? AND hold IS NULL").all(principal) as {id:string;size:number}[]){
    const physical=(await stat(join(v.directory,"objects",row.id))).size;assert.equal(row.size,physical);objects+=physical;
  }
  assert.equal(v.storage.usage(principal).used_bytes,records+reservations+objects);
  const global=Number((v.db.prepare("SELECT bytes FROM storage_global WHERE id=1").get() as any).bytes);
  const all=Number((v.db.prepare("SELECT COALESCE(SUM(n),0) n FROM (SELECT length(payload) n FROM records UNION ALL SELECT size n FROM raw_objects UNION ALL SELECT remaining n FROM storage_reservations)").get() as any).n);
  assert.equal(global,all);
}
test("all encrypted record kinds, replacements, reservations and rollbacks share the same exact quota",()=>fixture(async v=>{
  const a=v.put("A","secret",{value:"a".repeat(20000)});
  for(const kind of ["model_page","json_page","job","view","auth_context"])v.put("A",kind,{value:"small"});
  const before=v.storage.usage("A").used_bytes;v.put("A","secret",{value:"b".repeat(10000)},undefined,a);
  assert.equal(v.storage.usage("A").used_bytes,before-10000);
  v.storage.reserve("A","hold",10000,"upload",Date.now()+10000);
  const reserved=v.storage.usage("A").used_bytes;
  assert.throws(()=>v.storage.atomic(()=>{v.storage.reserve("A","rollback",100,"upload",Date.now()+10000);v.put("A","secret",{value:"transient"});throw Error("rollback");}));
  assert.equal(v.storage.usage("A").used_bytes,reserved);
  assert.equal(v.storage.reservation("A","rollback"),undefined);
  assert.throws(()=>v.put("A","secret",{value:"x".repeat(70000)}),{code:"storage_quota"});
  assert.throws(()=>v.storage.reserve("A","bad",-1,"upload",Date.now()+10000));
  v.storage.release("A","hold");assert.equal(v.storage.usage("A").used_bytes,reserved-10000);
  await check(v,"A");
},65536,131072));
test("per-principal and global limits are both enforced without borrowing another user's reservation",()=>fixture(async v=>{
  v.put("A","secret",{value:"a".repeat(60000)});v.put("B","secret",{value:"b".repeat(35000)});
  assert.throws(()=>v.put("A","secret",{value:"x".repeat(10000)}),{code:"storage_quota"});
  assert.throws(()=>v.put("B","secret",{value:"x".repeat(10000)}),{code:"storage_quota"});
  const b=v.storage.usage("B").used_bytes;
  v.storage.reserve("A","owned",1000,"upload",Date.now()+10000);
  const held=v.storage.reservation("A","owned")!.remaining;
  assert.throws(()=>v.withReservation("A","owned",()=>v.put("B","secret",{value:"x".repeat(10000)})),{code:"storage_quota"});
  assert.equal(v.storage.reservation("A","owned")!.remaining,held);assert.equal(v.storage.usage("B").used_bytes,b);
  await check(v,"A");await check(v,"B");
},65536,100000));
test("quota interruption retains an exact partial original and releases unused capacity",()=>fixture(async v=>{
  const raw=await v.capture("A",(async function*(){yield Buffer.alloc(4096,1);yield Buffer.alloc(4096,2);})(),10000,undefined,undefined,true);
  assert.equal(raw.interrupted,true);assert.equal(raw.interruption_code,"storage_quota");assert.ok(raw.size>4096&&raw.size<8192);
  assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",raw.raw_ref) as any).arrayBuffer()),Buffer.concat([Buffer.alloc(4096,1),Buffer.alloc(4096,2)]).subarray(0,raw.size));
  assert.equal(v.get("A",raw.raw_ref,"raw").transfer_complete,false);
  assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
  await check(v,"A");
},6000,12000));
test("failed capture and failed physical deletion do not invent free space",()=>fixture(async(v,dir)=>{
  const before=v.storage.usage("A").used_bytes;
  await assert.rejects(v.capture("A",(async function*(){yield Buffer.from("first");throw Error("cut");})(),100));
  assert.equal(v.storage.usage("A").used_bytes,before);
  const raw=await v.capture("A",source(Buffer.from("raw")),100),used=v.storage.usage("A").used_bytes;
  const path=join(dir,"objects",raw.raw_ref);await unlink(path);await mkdir(path);
  await assert.rejects(v.removeRaw("A",raw.raw_ref));assert.equal(v.storage.usage("A").used_bytes,used);
  assert.equal(v.storage.object(raw.raw_ref)!.state,"deleting");
  assert.ok((await v.cleanup()).failures>0);assert.equal(v.storage.usage("A").used_bytes,used);
  await rmdir(path);await writeFile(path,"raw");await v.cleanup();
  assert.equal(v.storage.usage("A").used_bytes,before);
  await check(v,"A");
}));
test("upload chunks, rejected completion, assembly and cleanup use one transferable reservation",()=>fixture(async(v,dir)=>{
  const s=new Staging(v,new DownloadPolicy([]),{maxFileBytes:1000,quotaBytes:200000}),u=new Uploads(s,4),bytes=Buffer.from("abcdefgh");
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8,sha256:"0".repeat(64)}).upload_ref;
  const promised=v.storage.usage("A").used_bytes;
  for(let i=0;i<2;i++){const b=bytes.subarray(i*4,i*4+4);await u.append("A",ref,i,sha(b),source(b));}
  assert.equal(v.storage.usage("A").used_bytes,promised);await check(v,"A");
  await assert.rejects(u.complete("A",ref),{code:"file_hash"});assert.equal(v.storage.usage("A").used_bytes,promised);
  await u.abort("A",ref);
  assert.equal((await readdir(join(dir,"objects"))).length,0);
  assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);await check(v,"A");
}));
test("a full quota rejects execution before send but still records the accepted job's terminal state",()=>fixture(async v=>{
  v.replaceBinding("A","key-A",uuid,0);let sent=0;
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json({major:3,minor:3,patch:5,prerelease:null});}) as typeof fetch,1024*1024,256);
  const jobs=new Jobs(v,e,()=>({secret:async()=>{throw Error();},file:async()=>{throw Error();}}),{autoStart:false});
  try{
    const ack=await jobs.submit("A",{operation_id:"getServerVersion"});
    const filler=v.put("A","view",{value:"x".repeat(450000)});
    jobs.start();await jobs.idle();
    const done=jobs.get("A",ack.job_ref);assert.equal(done.state,"failed");assert.equal(done.send_started,false);assert.equal(done.diagnostic.code,"storage_quota");assert.equal(sent,0);
    assert.equal(v.storage.reservation("A","status_"+ack.job_ref),undefined);
    v.db.prepare("DELETE FROM records WHERE principal='A' AND id=?").run(filler);
    await check(v,"A");
  }finally{await jobs.close();}
},1024*1024,2*1024*1024));
test("upstream storage exhaustion is explicit and cannot become a successful binary response",()=>fixture(async v=>{
  v.replaceBinding("A","key-A",uuid,0);let sent=0;
  const bytes=Buffer.alloc(600000,7),e=new Executor("http://immich/api",v,(async()=>{
    sent++;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,300000));controller.enqueue(bytes.subarray(300000));controller.close();}}),{headers:{"content-type":"application/octet-stream"}});
  }) as typeof fetch,2*1024*1024,256);
  const result=await e.call("A",{operation_id:"downloadAsset",path:{id:uuid}});
  assert.equal(sent,1);assert.equal(result.state,"outcome_unknown");assert.equal(result.diagnostic?.code,"storage_quota");
  const saved=v.get("A",result.result_ref!,"result");assert.ok(saved.raw.size>300000&&saved.raw.size<600000);
  assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes.subarray(0,saved.raw.size));
  assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
  await check(v,"A");
},700000,1400000));
test("storage-root ownership prevents different databases from collecting each other's objects",()=>fixture(async(v,dir)=>{
  const other=join(dir,"other.sqlite");
  assert.throws(()=>new Vault(dir,randomBytes(32),"test",other));
  await assert.rejects(stat(other),{code:"ENOENT"});
  const raw=await v.capture("A",source(Buffer.from("raw")),100),reader=v.rawStream("A",raw.raw_ref);
  assert.throws(()=>v.close(),{code:"store_busy"});await new Response(reader as any).arrayBuffer();
}));
test("upload reservations and exact counters survive actual SQLite close/reopen and final assembly",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-quota-reopen-")),key=randomBytes(32),limits={quotaBytes:2*1024*1024,globalQuotaBytes:4*1024*1024};
  let v=new Vault(dir,key,"test",undefined,limits);
  try{
    const s=new Staging(v,new DownloadPolicy([]),{maxFileBytes:1000,quotaBytes:200000}),u=new Uploads(s,4),bytes=Buffer.from("abcdefgh");
    const start=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8});await u.append("A",start.upload_ref,0,sha(bytes.subarray(0,4)),source(bytes.subarray(0,4)));
    const before=v.storage.usage("A").used_bytes;v.close();v=new Vault(dir,key,"test",undefined,limits);
    assert.equal(v.storage.usage("A").used_bytes,before);
    const resumed=new Uploads(new Staging(v,new DownloadPolicy([]),{maxFileBytes:1000,quotaBytes:200000}),4);
    await resumed.append("A",start.upload_ref,1,sha(bytes.subarray(4)),source(bytes.subarray(4)));
    const result=await resumed.complete("A",start.upload_ref);assert.equal(result.sha256,sha(bytes));
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);assert.equal((await readdir(join(dir,"objects"))).length,1);await check(v,"A");
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
test("a killed writer's incomplete object is charged by its physical bytes until orphan cleanup",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-quota-crash-")),key=randomBytes(32);
  const code=`import {Vault} from "./src/vault.ts";import {stat} from "node:fs/promises";import {join} from "node:path";
const v=new Vault(process.argv[1],Buffer.from(process.argv[2],"hex"),"test");
await v.capture("A",(async function*(){yield Buffer.alloc(4096,1);for(let i=0;i<1000;i++){
const row=v.db.prepare("SELECT id FROM raw_objects WHERE principal='A'").get();try{if((await stat(join(process.argv[1],"objects",row.id))).size>=4096)process.exit(17);}catch{}
await new Promise(r=>setTimeout(r,2));}throw Error("file was not written");})(),65536);`;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",code,dir,key.toString("hex")],{encoding:"utf8",timeout:30000});
  let v:Vault|undefined;
  try{
    assert.equal(child.status,17,child.stderr);v=new Vault(dir,key,"test");
    assert.equal(v.storage.usage("A").used_bytes,4096);
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
    await v.cleanup({orphanGraceMs:0});assert.equal(v.storage.usage("A").used_bytes,0);await check(v,"A");
  }finally{v?.close();await rm(dir,{recursive:true,force:true});}
});
