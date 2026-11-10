import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp,mkdir,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { Contexts } from "../src/contexts.js";
import { AccessAuth } from "../src/access.js";
import { Control } from "../src/control.js";
import { Views } from "../src/views.js";
import { registry } from "../src/registry.js";
import { sample,uuid } from "./fixtures.js";
const otherId="22222222-2222-4222-8222-222222222222",version={major:3,minor:3,patch:5,prerelease:null},secret="ROTATED-SECRET-CANARY";
const resolver=()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}});
const response=(id=uuid)=>({...sample(registry.schemas.ApiKeyCreateResponseDto!),id,secret});
const access=()=>new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example"});
async function fixture(run:(s:{vault:Vault;directory:string;root:string;key:Buffer})=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"immich-rotation-receipt-")),directory=join(root,"data"),key=randomBytes(32);await mkdir(directory);
  const s={vault:new Vault(directory,key,"rotation-receipt"),directory,root,key};
  s.vault.replaceBinding("A","OLD-KEY-CANARY",uuid,0);s.vault.replaceBinding("B","OTHER-KEY-CANARY",otherId,0);
  try{await run(s);}finally{s.vault.close();await rm(root,{recursive:true,force:true});}
}
test("a self-rotation job keeps its own result across the new binding and SQLite reopen while older jobs stay invalid",()=>fixture(async s=>{
  let rotations=0;const keys:string[]=[],http=(async(url:any,init:any)=>{
    keys.push(init.headers.get("x-api-key"));if(String(url).includes("/api-keys/")){rotations++;return Response.json(response(),{status:201});}
    return Response.json(version);
  }) as typeof fetch;
  let e=new Executor("http://immich/api",s.vault,http),jobs=new Jobs(s.vault,e,resolver);
  const old=await jobs.submit("A",{operation_id:"getServerVersion"});await jobs.idle();await jobs.close();
  jobs=new Jobs(s.vault,e,resolver,{autoStart:false});
  const rotated=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}}),stale=await jobs.submit("A",{operation_id:"getServerVersion"});
  s.vault.db.prepare("UPDATE jobs SET created=created+1000 WHERE id=?").run(stale.job_ref);jobs.start();await jobs.idle();
  let result=jobs.get("A",rotated.job_ref);
  assert.equal(result.state,"completed");assert.equal(result.credential_revision,1);assert.equal(s.vault.credential("A").revision,2);assert.equal(s.vault.credential("A").key,secret);
  assert.equal(result.result.operation_id,"rotateApiKey");assert.equal(result.result.request_id,rotated.request_id);assert.equal(result.diagnostic,null);
  assert.equal(jobs.get("A",old.job_ref).result,null);assert.equal(jobs.get("A",stale.job_ref).state,"cancelled");assert.equal(rotations,1);
  assert.throws(()=>jobs.get("B",rotated.job_ref));assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes("OLD-KEY-CANARY"));
  const stored=s.vault.get("A",result.result.result_ref,"result");assert.equal(stored.revision,2);assert.equal(stored.binding_transition.from_revision,1);
  const cipher=await readFile(join(s.directory,"objects",stored.raw.raw_ref));assert.ok(!cipher.includes(Buffer.from(secret)));
  const ref=result.result.result_ref;await jobs.close();await e.close();s.vault.close();s.vault=new Vault(s.directory,s.key,"rotation-receipt");
  e=new Executor("http://immich/api",s.vault,http);jobs=new Jobs(s.vault,e,resolver);
  try{
    await jobs.idle();result=jobs.get("A",rotated.job_ref);assert.equal(result.result.result_ref,ref);assert.equal(rotations,1);
    const control=new Control(access(),s.vault,e,s.key);assert.equal(control.readResult("A",ref).operation_id,"rotateApiKey");assert.throws(()=>control.readResult("B",ref));
    const next=await jobs.submit("A",{operation_id:"getServerVersion"});await jobs.idle();assert.equal(jobs.get("A",next.job_ref).state,"completed");assert.equal(keys.at(-1),secret);
    s.vault.replaceBinding("A","UNRELATED-KEY",otherId,2);assert.equal(jobs.get("A",rotated.job_ref).result,null);assert.throws(()=>control.readResult("A",ref));
  }finally{await jobs.close();await e.close();}
}));
test("a large encoded rotation result updates the key from validated projected fields beyond the inline limit",()=>fixture(async s=>{
  let sent=0;const body={...response(),name:"n".repeat(200000)},compressed=gzipSync(JSON.stringify(body));
  const e=new Executor("http://immich/api",s.vault,(async()=>{sent++;return new Response(compressed,{status:201,headers:{"content-type":"application/json","content-encoding":"gzip"}});}) as typeof fetch,1048576,1024,{jsonValueBytes:524288});
  const jobs=new Jobs(s.vault,e,resolver);
  try{
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();const result=jobs.get("A",ack.job_ref);
    assert.equal(result.state,"completed");assert.equal(result.result.data,null);assert.equal(s.vault.credential("A").key,secret);assert.equal(sent,1);
    const control=new Control(access(),s.vault,e,s.key),views=new Views(s.vault,control,1024);
    assert.equal(views.read("A",{result_ref:result.result.result_ref,json_pointer:"/data/id"}).data,uuid);
    assert.match(views.read("A",{result_ref:result.result.result_ref,json_pointer:"/data/secret"}).data.secret_ref,/^secret_/);
    assert.ok(!JSON.stringify(result).includes(secret));
  }finally{await jobs.close();await e.close();}
}));
for(const failedKind of ["result","job"] as const)test("a failed "+failedKind+" write rolls back the key transition and leaves every visible display uncertain",()=>fixture(async s=>{
  let sent=0;const v=s.vault,original=v.put.bind(v),before=v.binding("A")!;
  v.put=((principal:string,kind:string,data:any,...args:any[])=>{
    if(principal==="A"&&(failedKind==="result"&&kind==="result"&&data.revision===2||failedKind==="job"&&kind==="job"&&data.result?.state==="completed"))throw Error("simulated local commit failure");
    return original(principal,kind,data,...args as [number?,string?,string?]);
  }) as typeof v.put;
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json(response(),{status:201});}) as typeof fetch),jobs=new Jobs(v,e,resolver);
  try{
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();const result=jobs.get("A",ack.job_ref);
    assert.equal(result.state,"outcome_unknown");assert.equal(result.result.state,"outcome_unknown");assert.equal(result.result.diagnostic.code,"rotation_recovery_required");assert.equal(result.diagnostic.code,"rotation_recovery_required");
    assert.equal(v.credential("A").key,"OLD-KEY-CANARY");assert.equal(v.binding("A")!.credential,before.credential);assert.equal(v.credential("A").revision,1);assert.equal(sent,1);
    const stored=v.get("A",result.result.result_ref,"result");assert.equal(stored.binding_transition,undefined);assert.equal(stored.display.state,"outcome_unknown");
    const control=new Control(access(),v,e,s.key),views=new Views(v,control);assert.equal(views.read("A",{result_ref:result.result.result_ref}).complete,false);
    const plaintext=Buffer.from(await new Response(v.rawStream("A",stored.raw.raw_ref) as any).arrayBuffer());assert.ok(plaintext.includes(Buffer.from(secret)));
    assert.ok(!JSON.stringify(result).includes(secret));await jobs.idle();assert.equal(sent,1);
  }finally{v.put=original;await jobs.close();await e.close();}
}));
test("a terminal receipt committed with the key survives a later job-store failure",()=>fixture(async s=>{
  const v=s.vault,original=v.put.bind(v);let receiptWrites=0,sent=0;
  v.put=((principal:string,kind:string,data:any,...args:any[])=>{
    if(principal==="A"&&kind==="job"&&data.result?.state==="completed"&&++receiptWrites===2)throw Error("post-commit receipt failure");
    return original(principal,kind,data,...args as [number?,string?,string?]);
  }) as typeof v.put;
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json(response(),{status:201});}) as typeof fetch),jobs=new Jobs(v,e,resolver);
  try{
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();
    assert.equal(receiptWrites,2);assert.equal(sent,1);assert.equal(v.credential("A").revision,2);const result=jobs.get("A",ack.job_ref);
    assert.equal(result.state,"completed");assert.equal(result.result.state,"completed");assert.equal(result.diagnostic,null);
  }finally{v.put=original;await jobs.close();await e.close();}
}));
test("rotation cannot overwrite a concurrently replaced binding or adopt a different response key ID",()=>fixture(async s=>{
  let sent=0;let race=true;
  const e=new Executor("http://immich/api",s.vault,(async()=>{
    sent++;if(race)s.vault.replaceBinding("A","REPLACEMENT-KEY",otherId,1);return Response.json(response(race?uuid:otherId),{status:201});
  }) as typeof fetch),jobs=new Jobs(s.vault,e,resolver);
  try{
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();assert.equal(jobs.get("A",ack.job_ref).state,"outcome_unknown");
    assert.equal(jobs.get("A",ack.job_ref).result,null);assert.equal(s.vault.credential("A").key,"REPLACEMENT-KEY");
    race=false;s.vault.replaceBinding("A","OLD-KEY-CANARY",uuid,2);
    const wrong=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();const result=jobs.get("A",wrong.job_ref);
    assert.equal(result.state,"outcome_unknown");assert.equal(result.result.state,"outcome_unknown");assert.equal(s.vault.credential("A").revision,3);assert.equal(sent,2);
  }finally{await jobs.close();await e.close();}
}));
test("an explicitly consented session rotation hands its receipt to the same key while pausing the old context",()=>fixture(async s=>{
  let rotations=0;const e=new Executor("http://immich/api",s.vault,(async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname;
    if(init.method==="GET"&&path.includes("/api-keys/"))return Response.json({...sample(registry.schemas.ApiKeyResponseDto!),id:uuid});
    rotations++;assert.equal(init.headers.get("authorization"),"Bearer session-A");assert.equal(init.headers.get("x-api-key"),null);
    return Response.json(response(),{status:201});
  }) as typeof fetch),contexts=new Contexts(s.vault,e,"https://mcp.example");
  const connected=await contexts.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  const general=contexts.setSessionMode("A",connected.context_ref,connected.generation,true,true),jobs=new Jobs(s.vault,e,resolver,{},contexts);
  try{
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}},{context_ref:general.context_ref});await jobs.idle();
    const result=jobs.get("A",ack.job_ref);assert.equal(result.state,"completed");assert.equal(result.result.auth_context_kind,"explicit_session_workflow");assert.equal(rotations,1);
    assert.throws(()=>contexts.check("A",general.context_ref),{code:"context_revalidation_required"});
    const control=new Control(access(),s.vault,e,s.key,undefined,jobs,undefined,contexts);assert.equal(control.readResult("A",result.result.result_ref).state,"completed");
    contexts.revoke("A",general.context_ref,general.generation);assert.ok(jobs.get("A",ack.job_ref).result);
    s.vault.replaceBinding("A","FUTURE-KEY",uuid,2);assert.equal(jobs.get("A",ack.job_ref).result,null);
  }finally{await jobs.close();await e.close();}
}));

test("a rotation handoff cannot authorize another job or an inconsistent transition record",()=>fixture(async s=>{
  const e=new Executor("http://immich/api",s.vault,(async(url:any)=>String(url).includes("/api-keys/")?Response.json(response(),{status:201}):Response.json(version)) as typeof fetch);
  const jobs=new Jobs(s.vault,e,resolver);
  try{
    const prior=await jobs.submit("A",{operation_id:"getServerVersion"});await jobs.idle();
    const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});await jobs.idle();
    const result=jobs.get("A",ack.job_ref),ref=result.result.result_ref,record=s.vault.get("A",ref,"result"),old=s.vault.get("A",prior.job_ref,"job");
    old.result.result_ref=ref;s.vault.put("A","job",old,Date.now()+86400000,prior.job_ref);assert.equal(jobs.get("A",prior.job_ref).result,null);
    for(const patch of [{key_id:otherId},{from_revision:0},{to_revision:3},{context_ref:"unrelated-context"}]){
      s.vault.put("A","result",{...record,binding_transition:{...record.binding_transition,...patch}},Date.now()+3600000,ref);
      assert.equal(jobs.get("A",ack.job_ref).result,null);
    }
    for(const patch of [{context_ref:"unrelated-context"},{context_generation:123},{display:{...record.display,result_ref:"unrelated-result"}},{display:{...record.display,request_id:"unrelated-request"}}]){
      s.vault.put("A","result",{...record,...patch},Date.now()+3600000,ref);assert.equal(jobs.get("A",ack.job_ref).result,null);
    }
    s.vault.put("A","result",record,Date.now()+3600000,ref);assert.equal(jobs.get("A",ack.job_ref).result.result_ref,ref);
  }finally{await jobs.close();await e.close();}
}));

test("UUID letter case does not hide a successful self-rotation receipt or prevent updating the active key",()=>fixture(async s=>{
  const id="abcdefab-cdef-4abc-8def-abcdefabcdef";s.vault.replaceBinding("A","OLD-KEY-CANARY",id,1);let count=0;
  const e=new Executor("http://immich/api",s.vault,(async()=>{count++;return Response.json(response(count===1?id:id.toUpperCase()),{status:201});}) as typeof fetch),jobs=new Jobs(s.vault,e,resolver);
  try{
    for(const pathId of [id.toUpperCase(),id]){
      const ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:pathId}});await jobs.idle();const result=jobs.get("A",ack.job_ref);
      assert.equal(result.state,"completed");assert.equal(result.result.state,"completed");assert.equal(s.vault.credential("A").revision,2+count);assert.equal(s.vault.credential("A").key,secret);
    }
    assert.equal(count,2);
  }finally{await jobs.close();await e.close();}
}));
test("deleting the active API key through an uppercase UUID disconnects its local binding",()=>fixture(async s=>{
  const id="abcdefab-cdef-4abc-8def-abcdefabcdef";s.vault.replaceBinding("A","OLD-KEY-CANARY",id,1);
  const e=new Executor("http://immich/api",s.vault,(async()=>new Response(null,{status:204})) as typeof fetch);
  try{const result=await e.call("A",{operation_id:"deleteApiKey",path:{id:id.toUpperCase()}});assert.equal(result.state,"completed");assert.equal(s.vault.binding("A")!.state,"disconnected");assert.throws(()=>s.vault.credential("A"),{code:"key_required"});}
  finally{await e.close();}
}));
test("session ownership compares UUID identity without relaxing the candidate's authentication or owner",()=>fixture(async s=>{
  const id="abcdefab-cdef-4abc-8def-abcdefabcdef";s.vault.replaceBinding("A","OLD-KEY-CANARY",id,1);
  const e=new Executor("http://immich/api",s.vault,(async(url:any,init:any)=>{
    if(String(url).endsWith("/me")){
      assert.equal(init.headers.get("x-api-key"),"OLD-KEY-CANARY");assert.equal(init.headers.get("authorization"),null);
      return Response.json({...sample(registry.schemas.ApiKeyResponseDto!),id:id.toUpperCase()});
    }
    assert.equal(init.headers.get("x-api-key"),null);const token=init.headers.get("authorization");assert.ok(token==="Bearer session-A"||token==="Bearer session-B");
    return Response.json({...sample(registry.schemas.ApiKeyResponseDto!),id:token==="Bearer session-A"?id:otherId});
  }) as typeof fetch),contexts=new Contexts(s.vault,e,"https://mcp.example");
  try{
    const current=await contexts.register("A",{kind:"session",credential:"session-A",acknowledge:true});assert.equal(current.binding_revision,2);
    await assert.rejects(contexts.register("A",{kind:"session",credential:"session-B",acknowledge:true}),{code:"context_verification_failed"});
  }finally{await e.close();}
}));
