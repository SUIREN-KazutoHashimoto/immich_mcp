import test from "node:test";
import assert from "node:assert/strict";
import { createServer,type RequestListener,type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Vault } from "../src/vault.js";
import { Executor,type ExecutorLimits } from "../src/executor.js";
import { Contexts } from "../src/contexts.js";
import { Control } from "../src/control.js";
import { AccessAuth } from "../src/access.js";
import { Jobs } from "../src/jobs.js";
import { Application } from "../src/app.js";
import { registry } from "../src/registry.js";
import { sample,uuid } from "./fixtures.js";
const version={major:3,minor:3,patch:5,prerelease:null},pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const none=()=>({secret:async()=>{throw Error();},file:async()=>{throw Error();}});
const encoded=(res:ServerResponse,bytes:Buffer,status=200,mime="application/json",encoding="gzip")=>{
  res.writeHead(status,{"content-type":mime,"content-encoding":encoding,"content-length":bytes.length});res.end(bytes);
};
async function fixture(handler:RequestListener,run:(e:Executor,v:Vault,base:string,dir:string)=>Promise<void>,limits:ExecutorLimits={}){
  const server=createServer(handler),sockets=new Set<Socket>();
  server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const dir=await mkdtemp(join(tmpdir(),"immich-native-executor-")),base="http://127.0.0.1:"+(server.address() as any).port+"/api";
  const vault=new Vault(dir,randomBytes(32),"test",":memory:"),executor=new Executor(base,vault,undefined,2*1024*1024,4096,limits);
  vault.replaceBinding("A","key-A",uuid,0);
  try{await run(executor,vault,base,dir);}finally{
    try{await executor.close();}finally{
      try{vault.close();}finally{for(const socket of sockets)socket.destroy();
        await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});
      }
    }
  }
}
test("native executor decodes key verification and secret results while preserving exact gzip originals",async()=>{
  const body={...sample(registry.schemas.ApiKeyCreateResponseDto!),secret:"CREATED-KEY-CANARY"},raw=gzipSync(Buffer.from(JSON.stringify(body)));
  const seen:{url:string;key:string|undefined}[]=[];
  await fixture((req,res)=>{
    seen.push({url:req.url!,key:req.headers["x-api-key"] as string});
    if(req.url==="/api/api-keys/me")encoded(res,gzipSync(Buffer.from(JSON.stringify({...sample(registry.schemas.ApiKeyResponseDto!),id:uuid}))));
    else encoded(res,raw,201);
  },async(e,v)=>{
    await e.register("B","key-B",0);assert.equal(v.credential("B").key,"key-B");
    const result=await e.call("A",{operation_id:"createApiKey",body:sample(registry.schemas.ApiKeyCreateDto!)});
    assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));assert.ok(!JSON.stringify(result).includes("CREATED-KEY-CANARY"));
    assert.equal(v.get("A",result.data.secret.secret_ref,"secret").value,"CREATED-KEY-CANARY");
    const saved=v.get("A",result.result_ref!,"result");assert.equal(saved.raw.content_encoding,"gzip");assert.equal(saved.decoded_complete,true);
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),raw);
    assert.deepEqual(seen,[{url:"/api/api-keys/me",key:"key-B"},{url:"/api/api-keys",key:"key-A"}]);
  });
});
test("compressed JSONL retains PIN references and exact encoded bytes",async()=>{
  const records=[{type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),pinCode:"PIN-ENCODED-CANARY"},ack:"AuthUserV2|1"},{type:"SyncCompleteV1",data:{},ack:"SyncCompleteV1|done"}];
  const raw=gzipSync(Buffer.from(records.map(r=>JSON.stringify(r)+"\n").join("")));
  await fixture((_req,res)=>encoded(res,raw,200,"application/jsonlines+json"),async(e,v)=>{
    const result=await e.call("A",{operation_id:"getSyncStream",body:{types:["AuthUsersV2"]}});
    assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));assert.ok(!JSON.stringify(result).includes("PIN-ENCODED-CANARY"));
    assert.equal(v.get("A",result.data[0].data.pinCode.secret_ref,"secret").value,"PIN-ENCODED-CANARY");
    const saved=v.get("A",result.result_ref!,"result");assert.equal(saved.projection.complete,true);assert.equal(saved.projection.total_records,2);
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),raw);
  });
});
test("decode corruption, expansion limits and unknown coding retain complete originals with explicit failure",{timeout:30000},async()=>{
  const valid=gzipSync(Buffer.from(JSON.stringify(version))),broken=valid.subarray(0,-5),bomb=gzipSync(Buffer.from(JSON.stringify({...version,extra:"x".repeat(100000)})));
  let mode=0,requests=0;
  await fixture((_req,res)=>{requests++;encoded(res,mode===0?broken:mode===1?bomb:Buffer.from("payload"),200,"application/json",mode===2?"PRIVATE-CODING-CANARY":"gzip");},async(e,v)=>{
    for(const [index,expected,original]of [[0,"response_decode_failed",broken],[1,"decoded_result_limit",bomb],[2,"unsupported_content_encoding",Buffer.from("payload")]] as const){
      mode=index;const result=await e.call("A",{operation_id:"getServerVersion"});
      assert.equal(result.state,"failed");assert.equal(result.diagnostic?.code,expected);assert.equal(result.data,null);
      assert.ok(!JSON.stringify(result).includes("PRIVATE-CODING-CANARY"));
      const saved=v.get("A",result.result_ref!,"result");assert.equal(saved.raw.interrupted,false);assert.equal(saved.decoded_complete,false);
      assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),original);
    }
    assert.equal(requests,3);
  },{maxDecodedBytes:1024});
});
test("a compressed session result can be imported only through the explicit owner-verified workflow",async()=>{
  const login={...sample(registry.schemas.LoginResponseDto!),accessToken:"SESSION-ENCODED-CANARY"};
  const seen:{url:string;key:string|undefined;authorization:string|undefined}[]=[];
  await fixture((req,res)=>{
    seen.push({url:req.url!,key:req.headers["x-api-key"] as string,authorization:req.headers.authorization});
    const value=req.url==="/api/auth/login"?login:{...sample(registry.schemas.ApiKeyResponseDto!),id:uuid};
    encoded(res,gzipSync(Buffer.from(JSON.stringify(value))),req.url==="/api/auth/login"?201:200);
  },async(e,v)=>{
    const result=await e.call("A",{operation_id:"login",body:{email:"test@example.com"},secret_bindings:[{location:"body",pointer:"/password",secret_ref:"fixture-password"}]},
      {file:async()=>{throw Error();},secret:async()=>"synthetic-password"});
    assert.equal(result.state,"completed",JSON.stringify(result.diagnostic));
    const contexts=new Contexts(v,e,"https://mcp.example.test");
    const context=await contexts.register("A",{kind:"session",source_result_ref:result.result_ref!,acknowledge:true});
    assert.ok(context.context_ref);assert.ok(!JSON.stringify(context).includes("SESSION-ENCODED-CANARY"));
    assert.deepEqual(seen.map(r=>r.url),["/api/auth/login","/api/api-keys/me","/api/api-keys/"+uuid]);
    assert.equal(seen[1]!.key,"key-A");assert.equal(seen[2]!.key,undefined);assert.equal(seen[2]!.authorization,"Bearer SESSION-ENCODED-CANARY");
  });
});

test("waiting executions recheck changed credentials and expired secrets before dispatch",async()=>{
  const seen:string[]=[];
  await fixture((req,res)=>{seen.push(req.url!);if(req.url==="/api/hold")res.write("held");else res.end(JSON.stringify(version));},async(e,v,base)=>{
    const held=await e.http(base+"/hold",{redirect:"manual"});
    const changed=assert.rejects(e.call("A",{operation_id:"getServerVersion"}),{code:"credential_conflict"});
    await pause(30);v.replaceBinding("A","key-new",uuid,1);await held.body!.cancel();await changed;assert.deepEqual(seen,["/api/hold"]);
    const access=new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"});
    const control=new Control(access,v,e,randomBytes(32));
    const secret=v.put("A","secret",{value:"PASSWORD-CANARY",revision:2,operation_id:"login",pointer:"/password",location:"body"});
    const heldAgain=await e.http(base+"/hold",{redirect:"manual"});
    const expired=assert.rejects(e.call("A",{operation_id:"login",body:{email:"test@example.com"},secret_bindings:[{location:"body",pointer:"/password",secret_ref:secret}]},control.resolver("A","login")),{code:"invalid_reference"});
    await pause(30);v.db.prepare("UPDATE records SET expires=0 WHERE principal='A' AND id=?").run(secret);await heldAgain.body!.cancel();await expired;
    assert.deepEqual(seen,["/api/hold","/api/hold"]);assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
  },{upstream:{concurrency:1}});
});
test("a waiting context is revalidated after capacity acquisition",async()=>{
  const seen:string[]=[];
  await fixture((req,res)=>{seen.push(req.url!);res.write("held");},async(e,v,base)=>{
    const contexts=new Contexts(v,e,"https://mcp.example.test"),context=await contexts.register("A",{kind:"public",acknowledge:true});
    const held=await e.http(base+"/hold",{redirect:"manual"});
    const revoked=assert.rejects(contexts.call("A",context.context_ref,{operation_id:"getServerVersion"},none()),{code:"invalid_context"});
    await pause(30);contexts.revoke("A",context.context_ref,context.generation);await held.body!.cancel();await revoked;assert.deepEqual(seen,["/api/hold"]);
  },{upstream:{concurrency:1}});
});
test("job cancellation in the HTTP waiting queue remains unsent and does not replay",async()=>{
  const seen:string[]=[];
  await fixture((req,res)=>{seen.push(req.url!);if(req.url==="/api/hold")res.write("held");else{res.setHeader("content-type","application/json");res.end(JSON.stringify(version));}},async(e,v,base)=>{
    const held=await e.http(base+"/hold",{redirect:"manual"}),jobs=new Jobs(v,e,none);
    try{
      const accepted=await jobs.submit("A",{operation_id:"getServerVersion"});await pause(30);
      assert.equal(jobs.get("A",accepted.job_ref).state,"running");assert.equal(jobs.get("A",accepted.job_ref).send_started,false);
      jobs.cancel("A",accepted.job_ref);await jobs.idle();
      const cancelled=jobs.get("A",accepted.job_ref);assert.equal(cancelled.state,"cancelled");assert.equal(cancelled.send_started,false);
      await held.body!.cancel();assert.deepEqual(seen,["/api/hold"]);
      const next=await e.call("A",{operation_id:"getServerVersion"});assert.equal(next.state,"completed");assert.equal(seen.length,2);
    }finally{await jobs.close();}
  },{upstream:{concurrency:1}});
});
test("executor shutdown waits for an active encrypted capture and releases every reservation",async()=>{
  const bytes=Buffer.alloc(65536,7);let requested=false;
  await fixture((_req,res)=>{requested=true;res.setHeader("content-type","application/octet-stream");res.write(bytes);},async(e,v,_base,dir)=>{
    const active=e.call("A",{operation_id:"downloadAsset",path:{id:uuid}});
    const deadline=Date.now()+10000;let written=false;
    while(Date.now()<deadline){
      const row=v.db.prepare("SELECT id FROM raw_objects WHERE principal='A'").get() as {id:string}|undefined;
      if(row)try{if((await stat(join(dir,"objects",row.id))).size>0){written=true;break;}}catch{}
      await pause(5);
    }
    assert.equal(requested,true);assert.equal(written,true);await e.close();
    const result=await active;assert.equal(result.state,"outcome_unknown");assert.ok(result.result_ref);
    const saved=v.get("A",result.result_ref!,"result");assert.equal(saved.raw.interrupted,true);
    const original=Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer());
    assert.ok(original.length>0&&original.length<=bytes.length);assert.deepEqual(original,bytes.subarray(0,original.length));
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM storage_reservations").get()!.n,0);
    await assert.rejects(e.call("A",{operation_id:"getServerVersion"}),{code:"shutting_down"});
  });
});
test("application configuration controls one shared upstream limit and compressed version readiness",async()=>{
  let running=0,peak=0;
  await fixture((_req,res)=>{running++;peak=Math.max(peak,running);setTimeout(()=>{running--;encoded(res,gzipSync(Buffer.from(JSON.stringify(version))));},15);},async(_e,_v,base,dir)=>{
    const app=await Application.create({upstream:base,publicOrigin:"https://mcp.example.test",issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      directory:join(dir,"application"),masterKey:randomBytes(32),host:"127.0.0.1",port:0,maxUpstreamConcurrency:1,upstreamConnectTimeoutMs:1000,upstreamIdleTimeoutMs:10000},
      {versionIntervalMs:0,cleanupIntervalMs:0});
    try{
      assert.equal(app.health.state,"ok");for(const p of ["A","B","C"])app.vault.replaceBinding(p,"key-"+p,uuid,0);
      const results=await Promise.all(["A","B","C"].map(p=>app.executor.call(p,{operation_id:"getServerVersion"})));
      assert.ok(results.every(r=>r.state==="completed"));assert.equal(peak,1);
      assert.equal((await app.fetch(new Request("https://mcp.example.test/health/ready"))).status,200);
    }finally{await app.close();}
  });
});

test("local upstream saturation defers version checking without inventing an upstream outage",async()=>{
  await fixture((req,res)=>{if(req.url==="/api/hold")res.write("held");else encoded(res,gzipSync(Buffer.from(JSON.stringify(version))));},async(_e,_v,base,dir)=>{
    const app=await Application.create({upstream:base,publicOrigin:"https://mcp.example.test",issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      directory:join(dir,"application"),masterKey:randomBytes(32),host:"127.0.0.1",port:0,maxUpstreamConcurrency:1},
      {versionIntervalMs:0,cleanupIntervalMs:0});
    try{
      const before={...app.health},held=await app.executor.http(base+"/hold",{redirect:"manual"});
      await app.checkVersion();assert.deepEqual(app.health,before);assert.equal(app.health.state,"ok");
      await held.body!.cancel();await app.checkVersion();assert.equal(app.health.state,"ok");
      assert.notEqual(app.health.checked_at,before.checked_at);
    }finally{await app.close();}
  });
});

test("a large binary original does not claim skipped inspection bytes or expose an empty preview",async()=>{
  const bytes=Buffer.alloc(128*1024,9);
  await fixture((_req,res)=>{res.setHeader("content-type","application/octet-stream");res.end(bytes);},async(e,v)=>{
    const result=await e.call("A",{operation_id:"downloadAsset",path:{id:uuid}});
    assert.equal(result.state,"completed");assert.equal(result.data,null);assert.equal(result.diagnostic?.code,"artifact_result");
    const saved=v.get("A",result.result_ref!,"result");assert.equal(saved.raw.size,bytes.length);
    assert.equal(saved.decoded_bytes_inspected,0);assert.equal(saved.decoded_complete,false);
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer()),bytes);
  });
});
