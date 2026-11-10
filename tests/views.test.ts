import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.js";
import { Views } from "../src/views.js";
import { Control } from "../src/control.js";
import { Executor } from "../src/executor.js";
import { AccessAuth } from "../src/access.js";
import { uuid } from "./fixtures.js";

async function setup(run:(v:Vault,views:Views,save:(display:any)=>Promise<string>)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-views-")),key=randomBytes(32),v=new Vault(dir,key,"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);
  const access=new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"});
  const control=new Control(access,v,new Executor("http://immich/api",v),key),views=new Views(v,control);
  const save=async(display:any)=>{
    const raw=await v.capture("A",(async function*(){yield Buffer.from('{"secret":"RAW-CANARY"}');})(),10000);
    return v.put("A","result",{revision:1,display,raw});
  };
  try{await run(v,views,save);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
test("result pages preserve array/object order and Unicode with bound cursors",()=>setup(async(_v,views,save)=>{
  const ref=await save({data:[0,1,2,3,4],text:"A\u96ea\ud83d\udcf7B",obj:{"a/b":1,"~x":2,z:3}});
  const first=views.read("A",{result_ref:ref,json_pointer:"/data",limit:2});
  assert.deepEqual(first.data,[0,1]);assert.equal(first.complete,false);
  const second=views.read("A",{result_ref:ref,json_pointer:"/data",limit:2,cursor:first.next_cursor!});
  assert.deepEqual(second.data,[2,3]);
  const last=views.read("A",{result_ref:ref,json_pointer:"/data",limit:2,cursor:second.next_cursor!});
  assert.deepEqual(last.data,[4]);assert.equal(last.complete,true);assert.equal(last.next_cursor,null);
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/text",cursor:first.next_cursor!}),{code:"invalid_cursor"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/data",mode:"text",cursor:first.next_cursor!}),{code:"invalid_cursor"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/data",cursor:first.next_cursor!,offset:1}),{code:"invalid_cursor"});
  assert.deepEqual(views.read("A",{result_ref:ref,json_pointer:"/obj",offset:1,limit:1}).data,{"~x":2});
  assert.equal(views.read("A",{result_ref:ref,json_pointer:"/obj/a~1b"}).data,1);
  assert.equal(views.read("A",{result_ref:ref,json_pointer:"/text",mode:"text",offset:2,limit:1}).data,"\ud83d\udcf7");
}));
test("all result read modes stay in the display and enforce ownership and revision",()=>setup(async(v,views,save)=>{
  const ref=await save({data:{pinCode:{secret_ref:"secret-owned"}},upstream:{status:200}});
  for(const mode of ["json","jsonl","text","metadata","preview"]){
    const page=views.read("A",{result_ref:ref,mode});
    assert.ok(!JSON.stringify(page).includes("RAW-CANARY"));
    assert.throws(()=>views.read("B",{result_ref:ref,mode}),{code:"invalid_reference"});
  }
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/raw"}),{code:"invalid_pointer"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/constructor"}),{code:"invalid_pointer"});
  v.replaceBinding("A","key-new",uuid,1);
  assert.throws(()=>views.read("A",{result_ref:ref}),{code:"invalid_reference"});
}));
test("schema views, TTL and byte limits require explicit narrower pages",()=>setup(async(v,views)=>{
  const ref=views.store("A",{items:[{name:"a".repeat(150000)}],small:7});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/items"}),{code:"result_page_too_large"});
  assert.equal(views.read("A",{result_ref:ref,json_pointer:"/items/0/name",offset:100,limit:10}).data,"a".repeat(10));
  assert.equal(views.read("A",{result_ref:ref,json_pointer:"/small"}).data,7);
  for(const limit of [0,1001,1.5,NaN])assert.throws(()=>views.read("A",{result_ref:ref,limit}),{code:"invalid_limit"});
  for(const offset of [-1,1.5,Infinity])assert.throws(()=>views.read("A",{result_ref:ref,offset}),{code:"invalid_cursor"});
  assert.throws(()=>views.read("A",{result_ref:ref,cursor:"not-json"}),{code:"invalid_cursor"});
  assert.throws(()=>views.read("A",{result_ref:ref,mode:"raw"}),{code:"invalid_mode"});
  v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(ref);
  assert.throws(()=>views.read("A",{result_ref:ref}),{code:"invalid_reference"});
}));
