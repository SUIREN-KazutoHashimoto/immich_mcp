import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { JsonProjection } from "../src/json-projection.js";
import { JsonTree } from "../src/json-tree.js";
import { Views } from "../src/views.js";
import { Control } from "../src/control.js";
import { AccessAuth } from "../src/access.js";
import { registry,operation } from "../src/registry.js";
import { redact,safeShape } from "../src/projection.js";
import { sample,uuid } from "./fixtures.js";
const marker=()=>({withheld:true,reason:"unreviewed_structure",original_available_in_control_ui:true});
const responseSchema=(id:string)=>operation(id).definition.responses["200"].content["application/json"].schema;
const access=()=>new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"});
async function withVault(run:(v:Vault,key:Buffer,dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-json-")),key=randomBytes(32),v=new Vault(dir,key,"test",":memory:");
  try{await run(v,key,dir);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
async function project(v:Vault,schema:any,value:any,id="getServerVersion",status=200){
  const p=new JsonProjection(v,"A",schema,id,status,()=>"secret-placeholder");
  const bytes=Buffer.from(JSON.stringify(value));
  for(let i=0;i<bytes.length;i+=73)await p.push(bytes.subarray(i,i+73));
  const meta=await p.finish();return p.tree.value(meta.root,10*1024*1024);
}
test("streamed JSON matches complete sanitized projections for every declared JSON success schema",()=>withVault(async v=>{
  for(const op of registry.operations){
    for(const [status,response] of Object.entries<any>(op.definition.responses)){
      const schema=response.content?.["application/json"]?.schema;
      if(!status.startsWith("2")||!schema)continue;
      const value=sample(schema),expected=redact(op.operationId,Number(status),safeShape(value,schema,0,marker),()=>"secret-placeholder");
      try{assert.deepEqual(await project(v,schema,value,op.operationId,Number(status)),expected);}
      catch(error){throw new Error(op.operationId+" status "+status,{cause:error});}
    }
  }
}));
test("large JSON arrays are paged from sanitized nodes with protected originals and scoped secret refs",()=>withVault(async(v,key)=>{
  v.replaceBinding("A","key-A",uuid,0);
  const item=sample(responseSchema("getAllSharedLinks"))[0];
  const values=Array.from({length:350},(_,i)=>({...item,key:"CAPABILITY-CANARY-"+i,password:"PASSWORD-CANARY",slug:"SLUG-CANARY",description:"entry-"+i+"-\u96ea"+"x".repeat(5000)}));
  const bytes=Buffer.from(JSON.stringify(values));assert.ok(bytes.length>1024*1024);
  const e=new Executor("http://immich/api",v,(async()=>new Response(Readable.toWeb(Readable.from((async function*(){
    for(let i=0;i<200;i++)yield bytes.subarray(i,i+1);
    for(let i=200;i<bytes.length;i+=4096)yield bytes.subarray(i,i+4096);
  })())) as ReadableStream<Uint8Array>,{headers:{"content-type":"application/json"}})) as typeof fetch,1024*1024*10,256);
  const result=await e.call("A",{operation_id:"getAllSharedLinks"});
  assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));assert.equal(result.data,null);
  const views=new Views(v,new Control(access(),v,e,key)),ref=result.result_ref!;
  const first=views.read("A",{result_ref:ref,json_pointer:"/data",limit:17});
  assert.equal(first.data.length,17);assert.equal(first.complete,false);assert.ok(!JSON.stringify(first).includes("CANARY"));
  const second=views.read("A",{result_ref:ref,json_pointer:"/data",limit:17,cursor:first.next_cursor!});
  assert.ok(second.data[0].description.startsWith("entry-17-\u96ea"));
  const secret=views.read("A",{result_ref:ref,json_pointer:"/data/300/key/secret_ref"}).data;
  assert.equal(v.get("A",secret,"secret").value,"CAPABILITY-CANARY-300");
  assert.throws(()=>views.read("B",{result_ref:ref,json_pointer:"/data"}),{code:"invalid_reference"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/raw"}),{code:"invalid_pointer"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/data/350"}),{code:"invalid_pointer"});
  const saved=v.get("A",ref,"result");assert.equal(saved.projection.kind,"json");
  assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes);
  const rows=v.db.prepare("SELECT payload FROM records WHERE kind='json_page'").all() as {payload:Buffer}[];
  assert.ok(rows.length>1);assert.ok(rows.every(r=>!r.payload.includes(Buffer.from("CANARY"))));
  v.replaceBinding("A","new-key",uuid,1);
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/data"}),{code:"invalid_reference"});
}));
test("nested arrays, unions, primitive roots and Unicode survive incremental parsing",()=>withVault(async v=>{
  const schema={type:"object",required:["items","zero","no","empty"],properties:{items:{type:"array",items:{type:"object",required:["id","value"],properties:{id:{type:"integer"},value:{type:"string"}}}},zero:{type:"integer"},no:{type:"boolean"},empty:{type:"string",nullable:true}}};
  const value={items:Array.from({length:230},(_,i)=>({id:i,value:"\u96ea-\ud83d\udcf7-"+i})),zero:0,no:false,empty:null};
  assert.deepEqual(await project(v,schema,value),value);
  assert.equal(await project(v,{type:"string"},"\u96ea-\ud83d\udcf7"),"\u96ea-\ud83d\udcf7");
  assert.equal(await project(v,{type:"integer"},0),0);assert.equal(await project(v,{type:"boolean"},false),false);
  const union=registry.schemas.AssetEditActionItemResponseDto!.properties.parameters;
  for(const branch of union.anyOf)assert.deepEqual(await project(v,union,sample(branch)),sample(branch));
}));
test("malformed JSON, duplicate fields, wrong types, required fields and UTF-8 do not publish a tree",()=>withVault(async v=>{
  const schema={type:"object",required:["x"],properties:{x:{type:"integer",minimum:0}}};
  for(const input of ['{"x":1,','{"x":1}{}','{"x":1,"x":2}','{"x":"1"}','{}','{"x":-1}','{"x":1,"unknown":"CANARY"}']){
    const p=new JsonProjection(v,"A",schema,"getServerVersion",200,()=>"secret-placeholder");
    await p.push(Buffer.from(input));await assert.rejects(p.finish());
    assert.equal(v.db.prepare("SELECT COUNT(*) AS n FROM json_pages WHERE tree=?").get(p.tree.id)!.n,0);
  }
  const p=new JsonProjection(v,"A",{type:"string"},"getServerVersion",200,()=>"secret-placeholder");
  await p.push(Uint8Array.of(34,0xe9));await assert.rejects(p.finish());
}));
test("unconstrained values are explicitly withheld and configured scalar/depth limits fail visibly",()=>withVault(async v=>{
  const schema={type:"object",required:["id","meta"],properties:{id:{type:"integer"},meta:{type:"object",additionalProperties:{}}}};
  const value={id:1,meta:{password:"ARBITRARY-CANARY",nested:["CAPABILITY-CANARY"]}};
  assert.deepEqual(await project(v,schema,value),{id:1,meta:marker()});
  const limited=new JsonProjection(v,"A",{type:"string"},"getServerVersion",200,()=>"secret",undefined,32);
  await limited.push(Buffer.from(JSON.stringify("x".repeat(100))));await assert.rejects(limited.finish(),{code:"json_value_limit"});
  const union=new JsonProjection(v,"A",{anyOf:[{type:"array"},{type:"object"}]},"getServerVersion",200,()=>"secret",undefined,128);
  await union.push(Buffer.from("[[],[],[],[],[],[],[],[],[],[]]"));await assert.rejects(union.finish(),{code:"json_value_limit"});
  const deep=new JsonProjection(v,"A",{},"getServerVersion",200,()=>"secret");
  await deep.push(Buffer.from("[".repeat(101)+"0"+"]".repeat(101)));await assert.rejects(deep.finish(),{code:"response_depth_limit"});
}));
test("a malformed upstream JSON response retains original bytes and reports tool failure",()=>withVault(async(v,key)=>{
  v.replaceBinding("A","key-A",uuid,0);let count=0;
  const bytes=Buffer.from('{"major":3,"minor":3,');
  const e=new Executor("http://immich/api",v,(async()=>{count++;return new Response(bytes,{headers:{"content-type":"application/json"}});}) as typeof fetch);
  const result=await e.call("A",{operation_id:"getServerVersion"});
  assert.equal(result.state,"failed");assert.equal(count,1);assert.equal(result.data,null);
  const saved=v.get("A",result.result_ref!,"result");
  assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes);
  const views=new Views(v,new Control(access(),v,e,key));
  assert.throws(()=>views.read("A",{result_ref:result.result_ref!,json_pointer:"/data/major"}),{code:"invalid_pointer"});
}));

test("large sanitized JSON trees survive an actual SQLite close/reopen",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-json-reopen-")),key=randomBytes(32);
  let v=new Vault(dir,key,"test");
  try{
    v.replaceBinding("A","key-A",uuid,0);
    const item=sample(responseSchema("getAllSharedLinks"))[0];
    const values=Array.from({length:180},(_,i)=>({...item,key:"REOPEN-CAPABILITY-"+i,description:"record-"+i}));
    const e=new Executor("http://immich/api",v,(async()=>Response.json(values)) as typeof fetch,1024*1024*10,256);
    const result=await e.call("A",{operation_id:"getAllSharedLinks"});assert.equal(result.state,"completed");
    v.close();v=new Vault(dir,key,"test");
    const views=new Views(v,new Control(access(),v,new Executor("http://immich/api",v),key));
    const page=views.read("A",{result_ref:result.result_ref!,json_pointer:"/data",offset:150,limit:20});
    assert.equal(page.data.length,20);assert.equal(page.data[0].description,"record-150");
    assert.ok(!JSON.stringify(page).includes("REOPEN-CAPABILITY"));
    const receipt=views.read("A",{result_ref:result.result_ref!,json_pointer:"/data/170/key/secret_ref"});
    assert.equal(v.get("A",receipt.data,"secret").value,"REOPEN-CAPABILITY-170");
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
