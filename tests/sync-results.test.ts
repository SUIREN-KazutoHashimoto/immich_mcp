import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Control } from "../src/control.js";
import { AccessAuth } from "../src/access.js";
import { Views } from "../src/views.js";
import { Jobs } from "../src/jobs.js";
import { waitForTestJob } from "./job-wait.js";
import { registry } from "../src/registry.js";
import mapping from "../contracts/sync-records.v3.3.5.json" with {type:"json"};
import { sample,uuid } from "./fixtures.js";
const line=(value:any)=>JSON.stringify(value)+"\n";
const complete={type:"SyncCompleteV1",data:{},ack:"SyncCompleteV1|complete"};
const user=(i=0)=>({type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),pinCode:"PIN-CANARY",name:"user-"+i+"-\u96ea"},ack:"AuthUserV2|"+i});
const call={operation_id:"getSyncStream",body:{types:["AuthUsersV2"]}};
const access=()=>new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"});
async function fixture(run:(v:Vault,execute:(bytes:Buffer,broken?:boolean,mime?:string)=>Promise<any>,views:Views)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-sync-")),key=randomBytes(32),v=new Vault(dir,key,"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);
  let bytes:Buffer=Buffer.alloc(0),broken=false,mime="application/jsonlines+json",hits=0;
  const e=new Executor("http://immich/api",v,(async(_url:any,init:any)=>{
    hits++;assert.equal(init.headers.get("x-api-key"),"key-A");
    const stream=async function*(){
      const start=Math.min(bytes.length,200);
      for(let i=0;i<start;i++)yield bytes.subarray(i,i+1);
      for(let i=start;i<bytes.length;i+=8096)yield bytes.subarray(i,i+8096);
      if(broken)throw Error("SYNTHETIC-TRANSPORT-CANARY");
    };
    return new Response(Readable.toWeb(Readable.from(stream())) as ReadableStream<Uint8Array>,{headers:{"content-type":mime}});
  }) as typeof fetch,10*1024*1024,256);
  const control=new Control(access(),v,e,key),views=new Views(v,control);
  const execute=async(value:Buffer,fail=false,type="application/jsonlines+json")=>{
    bytes=value;broken=fail;mime=type;const before=hits,result=await e.call("A",call);assert.equal(hits,before+1);return result;
  };
  try{await run(v,execute,views);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
test("JSONL streams beyond the inline limit into encrypted, ordered, secret-safe pages",()=>fixture(async(v,execute,views)=>{
  const records=Array.from({length:150},(_,i)=>user(i));records.push(complete as any);
  const bytes=Buffer.from(records.map(line).join(""));
  const result=await execute(bytes);
  assert.equal(result.state,"completed");assert.equal(result.truncated,true);assert.equal(result.data,null);assert.equal(result.diagnostic.code,"large_jsonl_result");
  assert.ok(!JSON.stringify(result).includes("PIN-CANARY"));const ref=result.result_ref;
  let cursor:string|undefined;const all:any[]=[];
  do{
    const page=views.read("A",{result_ref:ref,mode:"jsonl",limit:37,...(cursor?{cursor}:{})});
    assert.ok(!JSON.stringify(page).includes("PIN-CANARY"));all.push(...page.data);
    cursor=page.next_cursor ?? undefined;if(!cursor)assert.equal(page.complete,true);
  }while(cursor);
  assert.equal(all.length,151);assert.equal(all[149].data.name,"user-149-\u96ea");assert.equal(all[150].type,"SyncCompleteV1");
  const fromFullData=views.read("A",{result_ref:ref,json_pointer:"/data/149/data/name"});
  assert.equal(fromFullData.data,"user-149-\u96ea");
  const secret=views.read("A",{result_ref:ref,mode:"jsonl",json_pointer:"/149/data/pinCode/secret_ref"});
  assert.equal(v.get("A",secret.data,"secret").value,"PIN-CANARY");
  assert.throws(()=>views.read("B",{result_ref:ref,mode:"jsonl"}),{code:"invalid_reference"});
  assert.throws(()=>views.read("A",{result_ref:ref,json_pointer:"/projection"}),{code:"invalid_pointer"});
  const saved=v.get("A",ref,"result"),original=Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer());
  assert.deepEqual(original,bytes);assert.equal(saved.projection.complete,true);
  const meta=views.read("A",{result_ref:ref,mode:"metadata"}).data;
  assert.equal(meta.size_bytes,bytes.length);assert.equal(meta.stream.total_records,151);assert.equal(meta.transfer_complete,true);
  const encrypted=v.db.prepare("SELECT payload FROM records WHERE kind='model_page'").all() as {payload:Buffer}[];
  assert.ok(encrypted.length>1);assert.ok(encrypted.every(row=>!row.payload.includes(Buffer.from("PIN-CANARY"))));
  v.replaceBinding("A","key-new",uuid,1);
  assert.throws(()=>views.read("A",{result_ref:ref,mode:"jsonl"}),{code:"invalid_reference"});
}));
test("every emitted pinned SyncItem type validates and projects its formal fields",()=>fixture(async(_v,execute,views)=>{
  const records=Object.entries(mapping.record_schemas).filter(([type])=>!["SyncCompleteV1","SyncResetV1"].includes(type))
    .map(([type,name])=>({type,data:sample(registry.schemas[name]!),ack:type+"|1"}));
  records.push(complete);
  const result=await execute(Buffer.from(records.map(line).join("")));
  assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));
  const all=views.read("A",{result_ref:result.result_ref,mode:"jsonl",limit:1000}).data;
  assert.deepEqual(all.map((r:any)=>r.type),records.map(r=>r.type));
  assert.ok(all.find((r:any)=>r.type==="AssetFaceV2"));
}));
test("malformed records and missing terminals preserve original bytes and valid prefixes without success",()=>fixture(async(v,execute,views)=>{
  for(const [tail,code] of [
    ["{bad}\n","invalid_jsonl"],
    [line({type:"UnknownV1",data:{password:"UNKNOWN-CANARY"},ack:"x"}),"unknown_sync_record"],
    [line({...user(1),extra:"UNKNOWN-CANARY"}),"invalid_sync_record"],
    [line({...user(1),data:{...user(1).data,newSecret:"UNKNOWN-CANARY"}}),"projection_mismatch"],
    ["","missing_stream_terminal"],
    ['{"type":"AuthUserV2"',"incomplete_jsonl"],
    [line(complete)+line(user(2)),"records_after_terminal"]
  ]){
    const bytes=Buffer.from(line(user())+tail);
    const result=await execute(bytes);
    assert.equal(result.state,"failed");assert.equal(result.diagnostic.code,code);assert.equal(result.truncated,true);
    const page=views.read("A",{result_ref:result.result_ref,mode:"jsonl",limit:100});
    assert.equal(page.complete,false);assert.equal(page.next_cursor,null);assert.equal(page.data[0].type,"AuthUserV2");
    assert.ok(!JSON.stringify(page).includes("CANARY"));
    const raw=v.get("A",result.result_ref,"result").raw;
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
  }
}));
test("reset is an explicit terminal and wrong content type does not become stream success",()=>fixture(async(_v,execute,views)=>{
  const reset=await execute(Buffer.from(line({type:"SyncResetV1",data:{},ack:"SyncResetV1|reset"})));
  assert.equal(reset.state,"completed");assert.equal(reset.diagnostic.code,"sync_reset_required");
  assert.equal(views.read("A",{result_ref:reset.result_ref,mode:"jsonl"}).complete,true);
  const wrong=await execute(Buffer.from("{}"),false,"application/json");
  assert.equal(wrong.state,"failed");assert.equal(wrong.diagnostic.code,"unexpected_stream_content_type");
}));
test("interrupted JSONL retains received encrypted bytes and partial pages with outcome uncertainty",()=>fixture(async(v,execute,views)=>{
  const bytes=Buffer.from(line(user()));
  const result=await execute(bytes,true);assert.equal(result.state,"outcome_unknown");assert.equal(result.diagnostic.code,"response_interrupted");
  const saved=v.get("A",result.result_ref,"result");
  assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes);
  const page=views.read("A",{result_ref:result.result_ref,mode:"jsonl"});
  assert.equal(page.data.length,1);assert.equal(page.complete,false);
  assert.equal(views.read("A",{result_ref:result.result_ref,mode:"metadata"}).data.transfer_complete,false);
}));
test("a malformed sync job ends failed and never replays the upstream request",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-sync-job-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);let sent=0;
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return new Response("{bad}\n",{headers:{"content-type":"application/jsonlines+json"}});}) as typeof fetch);
  const jobs=new Jobs(v,e,()=>({secret:async()=>{throw Error();},file:async()=>{throw Error();}}),{autoStart:false});
  try{
    const ack=await jobs.submit("A",call);jobs.start();
    const done=await waitForTestJob(()=>jobs.get("A",ack.job_ref));
    assert.equal(done.state,"failed");assert.equal(done.result.state,"failed");assert.equal(sent,1);
  }finally{await jobs.close();v.close();await rm(dir,{recursive:true,force:true});}
});

test("sanitized JSONL pages survive closing and reopening the actual SQLite database",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-sync-reopen-")),key=randomBytes(32);
  let v=new Vault(dir,key,"test");
  try{
    v.replaceBinding("A","key-A",uuid,0);
    const bytes=Buffer.from(Array.from({length:90},(_,i)=>line(user(i))).join("")+line(complete));
    const e=new Executor("http://immich/api",v,(async()=>new Response(bytes,{headers:{"content-type":"application/jsonlines+json"}})) as typeof fetch);
    const result=await e.call("A",call);assert.equal(result.state,"completed");
    v.close();v=new Vault(dir,key,"test");
    const views=new Views(v,new Control(access(),v,new Executor("http://immich/api",v),key));
    const page=views.read("A",{result_ref:result.result_ref!,mode:"jsonl",offset:70,limit:20});
    assert.equal(page.data.length,20);assert.equal(page.data[0].data.name,"user-70-\u96ea");
    assert.ok(!JSON.stringify(page).includes("PIN-CANARY"));
    const saved=v.get("A",result.result_ref!,"result");
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes);
    const row=v.db.prepare("SELECT ref FROM result_pages WHERE principal='A' AND stream=? ORDER BY start LIMIT 1").get(saved.projection.stream_id) as any;
    v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(row.ref);
    assert.throws(()=>views.read("A",{result_ref:result.result_ref!,mode:"jsonl"}),{code:"invalid_reference"});
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
