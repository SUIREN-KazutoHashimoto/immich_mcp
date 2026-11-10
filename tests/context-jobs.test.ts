import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Contexts } from "../src/contexts.js";
import { Jobs } from "../src/jobs.js";
import { registry } from "../src/registry.js";
import { sample,uuid } from "./fixtures.js";

const resolver=()=>({file:async()=>{throw Error();},secret:async()=>"password"});
async function fixture(run:(v:Vault,c:Contexts,j:Jobs,seen:string[])=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-context-job-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);
  const seen:string[]=[];
  const http=(async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname,h=new Headers(init.headers);seen.push(path);
    if(path==="/api/api-keys/me"){assert.equal(h.get("x-api-key"),"key-A");return Response.json(sample(registry.schemas.ApiKeyResponseDto!));}
    if(path.startsWith("/api/api-keys/")){assert.equal(h.get("authorization"),"Bearer session-A");return Response.json(sample(registry.schemas.ApiKeyResponseDto!));}
    assert.equal(h.get("x-api-key"),null);
    if(path==="/api/oauth/authorize")return Response.json({url:"https://provider.example/?state=STATE-JOB"},{status:201});
    if(path==="/api/oauth/callback")return Response.json({...sample(registry.schemas.LoginResponseDto!),accessToken:"SECRET-JOB"},{status:201});
    return Response.json({major:3,minor:3,patch:5,prerelease:null});
  }) as typeof fetch;
  const e=new Executor("http://immich/api",v,http),c=new Contexts(v,e,"https://mcp.example.com");
  const j=new Jobs(v,e,resolver,{autoStart:false},c);
  try{await run(v,c,j,seen);}finally{await j.close();v.close();await rm(dir,{recursive:true,force:true});}
}
test("a queued public context job executes without an API key and keeps its accepted context",()=>fixture(async(v,c,j,seen)=>{
  const context=await c.register("U",{kind:"public",acknowledge:true});
  const ack=await j.submit("U",{operation_id:"getServerVersion"},{context_ref:context.context_ref});
  assert.equal(j.get("U",ack.job_ref).state,"queued");assert.equal(seen.length,0);
  j.start();await j.idle();
  const result=j.get("U",ack.job_ref);assert.equal(result.state,"completed");assert.equal(result.result.auth_context_kind,"public_auth");
  assert.equal(result.result.request_id,ack.request_id);assert.equal(v.binding("U"),undefined);
}));
test("queued context generation changes and other principals are rejected before upstream send",()=>fixture(async(v,c,j,seen)=>{
  const context=await c.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  await assert.rejects(j.submit("B",{operation_id:"getSyncAck"},{context_ref:context.context_ref}));
  const ack=await j.submit("A",{operation_id:"getSyncAck"},{context_ref:context.context_ref});
  const before=seen.length;c.revoke("A",context.context_ref,context.generation);j.start();await j.idle();
  assert.equal(j.get("A",ack.job_ref).send_started,false);assert.equal(j.get("A",ack.job_ref).state,"failed");assert.equal(seen.length,before);
}));
test("OAuth preflight and queued cancellation do not consume a callback; actual sending consumes once",()=>fixture(async(v,c,j,seen)=>{
  const context=await c.register("U",{kind:"public",acknowledge:true});
  await c.beginOAuth("U",context.context_ref,resolver());
  const callback=c.acceptOAuthCallback("U",c.callbackUrl+"?code=CODE-JOB&state=STATE-JOB");
  const adapter={context_ref:context.context_ref,adapter_inputs:{oauth_callback_ref:callback.callback_ref}};
  const first=await j.submit("U",{operation_id:"finishOAuth",body:{}},adapter);
  assert.equal(v.get("U",callback.callback_ref,"oauth_callback").used,false);
  j.cancel("U",first.job_ref);assert.equal(v.get("U",callback.callback_ref,"oauth_callback").used,false);
  const second=await j.submit("U",{operation_id:"finishOAuth",body:{}},adapter);j.start();await j.idle();
  assert.equal(j.get("U",second.job_ref).state,"completed");assert.equal(v.get("U",callback.callback_ref,"oauth_callback").used,true);
  assert.equal(seen.filter(p=>p==="/api/oauth/callback").length,1);
  await assert.rejects(j.submit("U",{operation_id:"finishOAuth",body:{}},adapter),{code:"invalid_callback"});
  assert.ok(!JSON.stringify(j.get("U",second.job_ref)).includes("SECRET-JOB"));
}));
