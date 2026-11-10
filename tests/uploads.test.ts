import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomBytes } from "node:crypto";
import { mkdtemp,rm,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Staging } from "../src/staging.js";
import { DownloadPolicy } from "../src/download.js";
import { Uploads } from "../src/uploads.js";

const bytes=Buffer.from([0,255,20,30,0,10,13,128]),sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const source=(b:Uint8Array)=>(async function*(){yield b;})();
async function fixture(run:(v:Vault,s:Staging,u:Uploads)=>Promise<void>,quota=64) {
  const dir=await mkdtemp(join(tmpdir(),"immich-chunks-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A","id-A",0);v.replaceBinding("B","key-B","id-B",0);
  const s=new Staging(v,new DownloadPolicy([]),{maxFileBytes:32,quotaBytes:quota});
  try{await run(v,s,new Uploads(s,3));}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
async function fill(u:Uploads,ref:string) {
  for(let i=0;i<3;i++){const b=bytes.subarray(i*3,(i+1)*3);await u.append("A",ref,i,sha(b),source(b));}
}
test("upload resumes, deduplicates accepted chunks, verifies original bytes and completes exactly once",()=>fixture(async(v,s,u)=>{
  const start=u.start("A",{filename:"photo.bin",mime:"application/octet-stream",size:bytes.length,sha256:sha(bytes)});
  await u.append("A",start.upload_ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3)));
  const retry=await u.append("A",start.upload_ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3)));
  assert.equal(retry.next_chunk,1);assert.equal(retry.received_bytes,3);
  const resumed=new Uploads(s,3);assert.equal(resumed.status("A",start.upload_ref).next_chunk,1);
  for(let i=1;i<3;i++){const b=bytes.subarray(i*3,(i+1)*3);await resumed.append("A",start.upload_ref,i,sha(b),source(b));}
  const result=await resumed.complete("A",start.upload_ref);
  assert.equal(result.sha256,sha(bytes));assert.deepEqual(await resumed.complete("A",start.upload_ref),result);
  const part=await s.file("A",result.file_ref);
  assert.deepEqual(Buffer.from(await new Response(part.open() as any).arrayBuffer()),bytes);
  const done=resumed.status("A",start.upload_ref);
  assert.equal(done.state,"completed");assert.equal(done.chunks.length,3);
  assert.equal((v.db.prepare("SELECT SUM(size) n FROM staging_usage WHERE principal='A'").get() as any).n,bytes.length);
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM upload_chunks").get() as any).n,0);
  assert.equal((await readdir(join(v.directory,"objects"))).length,1);
}));
test("upload ownership, credential revision and expiry apply to chunks and completion",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8}).upload_ref;
  assert.throws(()=>u.status("B",ref));
  await assert.rejects(u.append("B",ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3))));
  await assert.rejects(u.abort("B",ref));
  v.replaceBinding("A","changed-key","changed-id",1);
  assert.throws(()=>u.status("A",ref));
  await assert.rejects(u.complete("A",ref));
  assert.equal((await u.abort("A",ref)).state,"aborted");
  const expired=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8}).upload_ref;
  v.db.prepare("UPDATE records SET expires=1 WHERE principal=? AND id=?").run("A",expired);
  assert.throws(()=>u.status("A",expired));
}));
test("bad hashes, out-of-order and interrupted chunks leave the acknowledged offset unchanged",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8}).upload_ref;
  await assert.rejects(u.complete("A",ref),{code:"upload_incomplete"});
  await assert.rejects(u.append("A",ref,1,sha(bytes),source(bytes)),{code:"upload_order"});
  await assert.rejects(u.append("A",ref,0,sha(bytes.subarray(0,3)),source(bytes)),{code:"result_limit"});
  await assert.rejects(u.append("A",ref,0,"0".repeat(64),source(bytes.subarray(0,3))),{code:"chunk_hash"});
  const interrupted=async function*(){yield bytes.subarray(0,1);throw Error("cut");};
  await assert.rejects(u.append("A",ref,0,sha(bytes.subarray(0,3)),interrupted()));
  assert.equal(u.status("A",ref).next_chunk,0);assert.equal(u.status("A",ref).received_bytes,0);
  assert.deepEqual(await readdir(join(v.directory,"objects")),[]);
  await fill(u,ref);assert.equal((await u.complete("A",ref)).size,8);
}));
test("full-file checksum failure keeps chunks recoverable and abort releases quota",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8,sha256:"0".repeat(64)}).upload_ref;
  await fill(u,ref);await assert.rejects(u.complete("A",ref),{code:"file_hash"});
  assert.equal(u.status("A",ref).state,"open");
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='staged_file'").get() as any).n,0);
  assert.equal((await u.abort("A",ref)).state,"aborted");
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM staging_usage").get() as any).n,0);
  assert.deepEqual(await readdir(join(v.directory,"objects")),[]);
}));
test("a failed completion transaction can retry without losing chunks or creating duplicate file refs",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8}).upload_ref;
  await fill(u,ref);
  const original=v.put.bind(v);let fail=true;
  v.put=((p:string,k:string,data:any,...rest:any[])=>{
    if(fail&&k==="upload"&&data.state==="completed")throw Error("simulated commit failure");
    return original(p,k,data,...rest as [number?,string?]);
  }) as typeof v.put;
  await assert.rejects(u.complete("A",ref));assert.equal(u.status("A",ref).state,"open");
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='staged_file'").get() as any).n,0);
  fail=false;const result=await u.complete("A",ref);assert.equal(result.sha256,sha(bytes));
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='staged_file'").get() as any).n,1);
}));
test("concurrent requests cannot append the same index and quota reserves assembly workspace",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"x.bin",mime:"application/octet-stream",size:8}).upload_ref;
  assert.throws(()=>u.start("A",{filename:"y.bin",mime:"application/octet-stream",size:1}),{code:"staging_quota"});
  let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  const slow=async function*(){entered();await wait;yield bytes.subarray(0,3);};
  const first=u.append("A",ref,0,sha(bytes.subarray(0,3)),slow());await ready;
  await assert.rejects(u.append("A",ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3))),{code:"upload_busy"});
  release();await first;assert.equal(u.status("A",ref).next_chunk,1);await u.abort("A",ref);
},16));
test("empty files are staged without inventing a chunk or changing original bytes",()=>fixture(async(v,s,u)=>{
  const ref=u.start("A",{filename:"empty.bin",mime:"application/octet-stream",size:0,sha256:sha(Buffer.alloc(0))}).upload_ref;
  const result=await u.complete("A",ref);assert.equal(result.size,0);
  const part=await s.file("A",result.file_ref);assert.equal((await new Response(part.open() as any).arrayBuffer()).byteLength,0);
}));

test("upload resumes with encrypted chunks after closing and reopening SQLite",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-upload-reopen-")),key=randomBytes(32);
  let v=new Vault(dir,key,"test");
  try{
    v.replaceBinding("A","key-A","id-A",0);
    let staging=new Staging(v,new DownloadPolicy([]),{maxFileBytes:32,quotaBytes:64}),u=new Uploads(staging,3);
    const ref=u.start("A",{filename:"photo.bin",mime:"application/octet-stream",size:bytes.length,sha256:sha(bytes)}).upload_ref;
    await u.append("A",ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3)));
    v.close();v=new Vault(dir,key,"test");
    staging=new Staging(v,new DownloadPolicy([]),{maxFileBytes:32,quotaBytes:64});u=new Uploads(staging,3);
    assert.equal(u.status("A",ref).next_chunk,1);
    for(let i=1;i<3;i++){const b=bytes.subarray(i*3,(i+1)*3);await u.append("A",ref,i,sha(b),source(b));}
    const result=await u.complete("A",ref),part=await staging.file("A",result.file_ref);
    assert.equal(result.sha256,sha(bytes));
    assert.deepEqual(Buffer.from(await new Response(part.open() as any).arrayBuffer()),bytes);
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
