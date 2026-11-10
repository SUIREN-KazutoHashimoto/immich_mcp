import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile,readFile,unlink,mkdir,rmdir,utimes,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,randomUUID } from "node:crypto";
import { Vault } from "../src/vault.js";
import { JsonProjection } from "../src/json-projection.js";
import { ResultPages } from "../src/result-pages.js";
async function fixture(run:(v:Vault,dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-cleanup-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  try{await run(v,dir);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
test("cleanup expires records/objects and retires old keys without deleting active credentials or live data",()=>fixture(async(v,dir)=>{
  v.replaceBinding("A","old-key","id-A",0);const old=v.binding("A")!.credential!;
  v.replaceBinding("A","new-key","id-A",1);v.replaceBinding("B","key-B","id-B",0);
  const gone=v.put("A","secret",{value:"EXPIRED-CANARY"},0),live=v.put("B","secret",{value:"LIVE-CANARY"});
  const raw=await v.capture("A",(async function*(){yield Buffer.from("raw");})(),100);
  v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(raw.raw_ref);
  const report=await v.cleanup();
  assert.equal(report.failures,0);assert.ok(report.records_deleted>=3);assert.equal(report.objects_deleted,1);
  assert.throws(()=>v.get("A",gone,"secret"));assert.throws(()=>v.get("A",old,"credential"));
  assert.equal(v.credential("A").key,"new-key");assert.equal(v.credential("B").key,"key-B");
  assert.equal(v.get("B",live,"secret").value,"LIVE-CANARY");
  await assert.rejects(stat(join(dir,"objects",raw.raw_ref)),{code:"ENOENT"});
}));
test("cleanup removes expired display pages and indexes, with pinned records retained until release",()=>fixture(async v=>{
  const pages=new ResultPages(v,"A",0);for(let i=0;i<90;i++)pages.append({i});pages.flush();
  const p=new JsonProjection(v,"A",{type:"array",items:{type:"integer"}},"getServerVersion",200,()=>"secret",0);
  await p.push(Buffer.from(JSON.stringify(Array.from({length:100},(_,i)=>i))));await p.finish();
  const id=v.put("A","job",{call:{}},0),release=v.pin("A",id);
  const first=await v.cleanup();assert.equal(first.active_skipped,1);
  assert.equal(v.db.prepare("SELECT COUNT(*) AS n FROM json_pages").get()!.n,0);
  assert.equal(v.db.prepare("SELECT COUNT(*) AS n FROM result_pages").get()!.n,0);
  assert.ok(v.db.prepare("SELECT 1 FROM records WHERE id=?").get(id));
  release();await v.cleanup();assert.equal(v.db.prepare("SELECT 1 FROM records WHERE id=?").get(id),undefined);
}));
test("cleanup cannot delete active captures or readers, including an expired held reader",()=>fixture(async(v,dir)=>{
  let release!:()=>void,started!:()=>void;
  const hold=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const capture=v.capture("A",(async function*(){yield Buffer.from("one");started();await hold;yield Buffer.from("two");})(),100);
  await entered;
  const during=await v.cleanup({orphanGraceMs:0});assert.ok(during.active_skipped>=1);
  release();const raw=await capture;
  const reader=v.rawStream("A",raw.raw_ref);
  v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(raw.raw_ref);
  const held=await v.cleanup();assert.ok(held.active_skipped>=1);assert.equal(held.objects_deleted,0);
  assert.equal(await new Response(reader as any).text(),"onetwo");
  assert.equal(v.isPinned("A",raw.raw_ref),false);
  assert.equal((await v.cleanup()).objects_deleted,1);
  await assert.rejects(readFile(join(dir,"objects",raw.raw_ref)),{code:"ENOENT"});
}));
test("orphan scanning removes only old generated object files and preserves recent or unrelated entries",()=>fixture(async(v,dir)=>{
  const objects=join(dir,"objects");await mkdir(objects);
  const old="raw_"+randomUUID(),recent="raw_"+randomUUID(),directory="raw_"+randomUUID();
  await writeFile(join(objects,old),"old");await utimes(join(objects,old),new Date(0),new Date(0));
  await writeFile(join(objects,recent),"recent");await writeFile(join(objects,"keep.txt"),"unrelated");await mkdir(join(objects,directory));
  const report=await v.cleanup();
  assert.equal(report.orphan_objects_deleted,1);
  assert.equal(await readFile(join(objects,recent),"utf8"),"recent");assert.equal(await readFile(join(objects,"keep.txt"),"utf8"),"unrelated");
  assert.equal((await stat(join(objects,directory))).isDirectory(),true);
}));
test("failed object deletion retains its expired metadata for the next cleanup attempt",()=>fixture(async(v,dir)=>{
  const raw=await v.capture("A",(async function*(){yield Buffer.from("raw");})(),100);
  const path=join(dir,"objects",raw.raw_ref);await unlink(path);await mkdir(path);
  v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(raw.raw_ref);
  assert.equal((await v.cleanup()).failures,1);assert.ok(v.db.prepare("SELECT 1 FROM records WHERE id=?").get(raw.raw_ref));
  await rmdir(path);await writeFile(path,"expired");
  assert.equal((await v.cleanup()).failures,0);assert.equal(v.db.prepare("SELECT 1 FROM records WHERE id=?").get(raw.raw_ref),undefined);
}));
test("missing encrypted files produce a handled read error and release reader pins",()=>fixture(async(v,dir)=>{
  const raw=await v.capture("A",(async function*(){yield Buffer.from("raw");})(),100);await unlink(join(dir,"objects",raw.raw_ref));
  await assert.rejects(new Response(v.rawStream("A",raw.raw_ref) as any).arrayBuffer());
  assert.equal(v.isPinned("A",raw.raw_ref),false);
}));
