import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Contexts } from "../src/contexts.js";
import { registry } from "../src/registry.js";
import { uuid,sample } from "./fixtures.js";

const idB="22222222-2222-4222-8222-222222222222",newId="33333333-3333-4333-8333-333333333333";
const resolve={file:async()=>{throw Error();},secret:async()=>"password-fixture"};
const metadata=(id:string)=>({...sample(registry.schemas.ApiKeyResponseDto!),id});
interface Seen {path:string;headers:Headers;body:any;wireBody:any;query:URLSearchParams;}
async function fixture(run:(v:Vault,e:Executor,c:Contexts,seen:Seen[])=>Promise<void>,reply?:(s:Seen)=>Response|Promise<Response>) {
  const dir=await mkdtemp(join(tmpdir(),"immich-context-")),v=new Vault(dir,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A",uuid,0);v.replaceBinding("B","key-B",idB,0);
  const seen:Seen[]=[];
  const http=(async(url:any,init:any)=>{
    const u=new URL(String(url)),headers=new Headers(init.headers);
    const s={path:u.pathname,headers,wireBody:init.body,body:typeof init.body==="string"?JSON.parse(init.body):undefined,query:u.searchParams};
    seen.push(s);
    if(u.pathname==="/api/api-keys/me")return Response.json(metadata(headers.get("x-api-key")==="new-key"?newId:headers.get("x-api-key")==="key-B"?idB:uuid));
    if(u.pathname.startsWith("/api/api-keys/")){
      const id=u.pathname.split("/").at(-1)!;
      const owner=headers.get("authorization");
      if(owner==="Bearer session-A"&&[uuid,newId].includes(id)||owner==="Bearer session-B"&&id===idB)return Response.json(metadata(id));
      return Response.json({message:"wrong owner"},{status:403});
    }
    return reply?await reply(s):Response.json({message:"UPSTREAM-CANARY"},{status:403});
  }) as typeof fetch;
  const e=new Executor("http://immich/api",v,http),c=new Contexts(v,e,"https://mcp.example.com");
  try{await run(v,e,c,seen);}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
test("session registration uses only live getMyApiKey and candidate-session getApiKey to prove owner",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  assert.equal(ctx.mode,"special");assert.equal(ctx.api_key_permissions_inherited,false);
  assert.deepEqual(seen.map(s=>s.path),["/api/api-keys/me","/api/api-keys/"+uuid]);
  assert.equal(seen[0]!.headers.get("x-api-key"),"key-A");assert.equal(seen[0]!.headers.get("authorization"),null);
  assert.equal(seen[1]!.headers.get("x-api-key"),null);assert.equal(seen[1]!.headers.get("authorization"),"Bearer session-A");
  await assert.rejects(c.register("B",{kind:"session",credential:"session-A",acknowledge:true}),{code:"context_verification_failed"});
  assert.equal(c.list("B").length,0);
  await assert.rejects(c.register("A",{kind:"session",credential:"session-A",acknowledge:false}),{code:"context_consent"});
}));
test("default session workflow cannot become a general session through tool arguments",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  const before=seen.length;
  await assert.rejects(c.call("A",ctx.context_ref,{operation_id:"getServerVersion"},resolve),{code:"context_purpose"});
  await assert.rejects(c.call("A",ctx.context_ref,{operation_id:"getSyncAck",mode:"general_session"} as any,resolve),{code:"invalid_envelope"});
  assert.equal(seen.length,before);
  const result=await c.call("A",ctx.context_ref,{operation_id:"getSyncAck"},resolve);
  assert.equal(result.auth_context_kind,"session_special");assert.equal(result.upstream?.status,403);
  assert.equal(seen.at(-1)!.headers.get("authorization"),"Bearer session-A");
  assert.equal(seen.at(-1)!.headers.get("x-api-key"),null);
  assert.ok(!JSON.stringify(result).includes("session-A"));assert.ok(!JSON.stringify(result).includes("UPSTREAM-CANARY"));
  assert.throws(()=>c.setSessionMode("A",ctx.context_ref,ctx.generation,true,false));
  c.setSessionMode("A",ctx.context_ref,ctx.generation,true,true);
  await c.call("A",ctx.context_ref,{operation_id:"getServerVersion"},resolve);
  await e.call("A",{operation_id:"getServerVersion"});
  assert.equal(seen.at(-1)!.headers.get("x-api-key"),"key-A");assert.equal(seen.at(-1)!.headers.get("authorization"),null);
}));
test("key update pauses session and revalidation rechecks same owner with current revision",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  v.replaceBinding("A","new-key",newId,1);
  await assert.rejects(c.call("A",ctx.context_ref,{operation_id:"getSyncAck"},resolve),{code:"context_revalidation_required"});
  const verified=await c.revalidate("A",ctx.context_ref,ctx.generation);assert.equal(verified.binding_revision,2);
  assert.equal(seen.at(-1)!.path,"/api/api-keys/"+newId);
  v.replaceBinding("A","key-B",idB,2);
  await assert.rejects(c.revalidate("A",ctx.context_ref,verified.generation),{code:"context_verification_failed"});
}));
test("parallel users keep session headers, context refs and encrypted results separate",()=>fixture(async(v,e,c,seen)=>{
  const a=await c.register("A",{kind:"session",credential:"session-A",acknowledge:true});
  const b=await c.register("B",{kind:"session",credential:"session-B",acknowledge:true});
  const [ra,rb]=await Promise.all([c.call("A",a.context_ref,{operation_id:"getSyncAck"},resolve),c.call("B",b.context_ref,{operation_id:"getSyncAck"},resolve)]);
  assert.equal(seen.at(-2)!.headers.get("authorization"),"Bearer session-A");assert.equal(seen.at(-1)!.headers.get("authorization"),"Bearer session-B");
  assert.throws(()=>c.assertResult("B",v.get("A",ra.result_ref!,"result")));
  await assert.rejects(c.call("B",a.context_ref,{operation_id:"getSyncAck"},resolve));
  const record=v.get("A",ra.result_ref!,"result");c.revoke("A",a.context_ref,a.generation);assert.throws(()=>c.assertResult("A",record));
}));
test("public/setup workflow works without an API key and never activates a returned session",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("U",{kind:"public",acknowledge:true});
  const result=await c.call("U",ctx.context_ref,{operation_id:"login",body:{email:"u@example.com"},
    secret_bindings:[{location:"body",pointer:"/password",secret_ref:"ui-password"}]},resolve);
  assert.equal(result.upstream?.status,201);assert.equal(result.auth_context_kind,"public_auth");
  assert.equal(seen.at(-1)!.headers.get("x-api-key"),null);assert.equal(seen.at(-1)!.headers.get("authorization"),null);
  assert.ok(!JSON.stringify(result).includes("SESSION-CANARY"));assert.equal(v.binding("U"),undefined);
  c.assertResult("U",v.get("U",result.result_ref!,"result"));
  await assert.rejects(e.call("U",{operation_id:"getServerVersion"}),{code:"key_required"});
},()=>Response.json({...sample(registry.schemas.LoginResponseDto!),accessToken:"SESSION-CANARY"},{status:201,headers:{"set-cookie":"immich_access_token=SESSION-CANARY; Path=/"}})));
test("shared-link adapter uses only its key and own password cookie; ignores unrelated auth cookies",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("A",{kind:"shared_link",credential:"LINK-CANARY",share_type:"key",acknowledge:true});
  await c.call("A",ctx.context_ref,{operation_id:"sharedLinkLogin",body:{},secret_bindings:[{location:"body",pointer:"/password",secret_ref:"password"}]},resolve);
  await c.call("A",ctx.context_ref,{operation_id:"getMySharedLink"},resolve);
  const request=seen.at(-1)!;assert.equal(request.headers.get("x-immich-share-key"),"LINK-CANARY");
  assert.equal(request.headers.get("cookie"),"immich_shared_link_token=COOKIE-CANARY");
  assert.equal(request.headers.get("x-api-key"),null);assert.equal(request.headers.get("authorization"),null);
  await e.call("A",{operation_id:"getMySharedLink"});
  assert.equal(seen.at(-1)!.headers.get("x-api-key"),"key-A");assert.equal(seen.at(-1)!.headers.get("cookie"),null);
},s=>s.path==="/api/shared-links/login"?new Response(null,{status:201,headers:[["set-cookie","immich_shared_link_token=COOKIE-CANARY; Path=/api"],["set-cookie","immich_access_token=OTHER-USER-CANARY; Path=/"]]}):new Response(null,{status:403})));
test("maintenance workflow accepts a separate credential and does not duplicate rotated cookies",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("U",{kind:"maintenance",credential:"MAINTENANCE-OLD",acknowledge:true});
  const first=await c.call("U",ctx.context_ref,{operation_id:"listDatabaseBackups"},resolve);
  assert.equal(seen.at(-1)!.headers.get("cookie"),"immich_maintenance_token=MAINTENANCE-OLD");
  await c.call("U",ctx.context_ref,{operation_id:"listDatabaseBackups"},resolve);
  assert.equal(seen.at(-1)!.headers.get("cookie"),"immich_maintenance_token=MAINTENANCE-NEW");
  assert.equal(seen.at(-1)!.headers.get("x-api-key"),null);assert.ok(!JSON.stringify(first).includes("MAINTENANCE"));
},()=>new Response(null,{status:200,headers:{"set-cookie":"immich_maintenance_token=MAINTENANCE-NEW; Path=/api"}})));
test("OAuth callback is bound to principal, context, state, flow and single use",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("U",{kind:"public",acknowledge:true});
  const url=await c.beginOAuth("U",ctx.context_ref,resolve);assert.ok(url.includes("STATE-CANARY"));
  const raw=c.callbackUrl+"?code=CODE-CANARY&state=STATE-CANARY";
  assert.throws(()=>c.acceptOAuthCallback("A",raw),{code:"invalid_callback"});
  assert.throws(()=>c.acceptOAuthCallback("U",c.callbackUrl+"?code=x&state=wrong"),{code:"invalid_callback"});
  const callback=c.acceptOAuthCallback("U",raw);assert.deepEqual(c.acceptOAuthCallback("U",raw),callback);
  const result=await c.call("U",ctx.context_ref,{operation_id:"finishOAuth",body:{}},resolve,{oauth_callback_ref:callback.callback_ref});
  const request=seen.at(-1)!;
  assert.equal(request.body.url,raw);assert.equal(request.body.state,"STATE-CANARY");
  assert.ok(request.headers.get("cookie")!.includes("immich_oauth_code_verifier=VERIFIER-CANARY"));
  assert.ok(!JSON.stringify(result).includes("CODE-CANARY"));assert.ok(!JSON.stringify(result).includes("SESSION-CANARY"));
  const count=seen.length;
  await assert.rejects(c.call("U",ctx.context_ref,{operation_id:"finishOAuth",body:{}},resolve,{oauth_callback_ref:callback.callback_ref}),{code:"invalid_callback"});
  assert.equal(seen.length,count);
},s=>s.path==="/api/oauth/authorize"?Response.json({url:"https://provider.example/authorize?state=STATE-CANARY"},{status:201,headers:[["set-cookie","immich_oauth_state=STATE-CANARY; Path=/api"],["set-cookie","immich_oauth_code_verifier=VERIFIER-CANARY; Path=/api"]]}):
  Response.json({...sample(registry.schemas.LoginResponseDto!),accessToken:"SESSION-CANARY"},{status:201,headers:{"set-cookie":"immich_oauth_state=; Max-Age=0; Path=/api"}})));
test("mobile OAuth redirect restores only validated workflow query and keeps 307 Location private",()=>fixture(async(v,e,c,seen)=>{
  const ctx=await c.register("U",{kind:"public",acknowledge:true});await c.beginOAuth("U",ctx.context_ref,resolve);
  const callback=c.acceptOAuthCallback("U",c.callbackUrl+"?code=MOBILE-CODE&state=STATE-CANARY");
  const result=await c.call("U",ctx.context_ref,{operation_id:"redirectOAuthToMobile"},resolve,{oauth_callback_ref:callback.callback_ref});
  assert.equal(seen.at(-1)!.query.get("code"),"MOBILE-CODE");assert.equal(result.upstream?.status,307);
  assert.ok(!JSON.stringify(result).includes("MOBILE-CODE"));
  await assert.rejects(c.call("U",ctx.context_ref,{operation_id:"redirectOAuthToMobile",query:{code:"raw"}},resolve),{code:"unknown_parameter"});
},s=>s.path==="/api/oauth/authorize"?Response.json({url:"https://provider.example/authorize?state=STATE-CANARY"},{status:201}):new Response(null,{status:307,headers:{location:"app://login?code=MOBILE-CODE"}})));

test("OAuth state is a declared secret input and cannot be passed inline",async()=>{
  const {prepare}=await import("../src/serializer.js");
  await assert.rejects(prepare("http://immich/api",{operation_id:"startOAuth",body:{redirectUri:"https://mcp.example.com/connect/oauth/callback",state:"SECRET-STATE"}}),{code:"secret_reference_required"});
});
test("maintenance upload stages a principal-owned file without an API-key binding",()=>fixture(async(v,e,c,seen)=>{
  const {Staging}=await import("../src/staging.js"),{DownloadPolicy}=await import("../src/download.js");
  const s=new Staging(v,new DownloadPolicy([]));
  const bytes=Buffer.from([0,255,128,10]);
  const file=await s.ingest("U","backup.gz","application/gzip",(async function*(){yield bytes;})());
  const ctx=await c.register("U",{kind:"maintenance",credential:"MAINTENANCE-TOKEN",acknowledge:true});
  const result=await c.call("U",ctx.context_ref,{operation_id:"uploadDatabaseBackup",files:{file:{file_ref:file.file_ref}}},
    {file:ref=>s.file("U",ref),secret:async()=>{throw Error();}});
  assert.equal(result.upstream?.status,201);assert.equal(v.binding("U"),undefined);
  assert.equal(seen.at(-1)!.headers.get("cookie"),"immich_maintenance_token=MAINTENANCE-TOKEN");
},async request=>{
  const form=await new Response(request.wireBody,{headers:request.headers}).formData();
  assert.deepEqual(Buffer.from(await (form.get("file") as File).arrayBuffer()),Buffer.from([0,255,128,10]));
  return new Response(null,{status:201});
}));

test("a secret expiring after resolution is rejected again before any context request is sent",()=>fixture(async(v,e,c,seen)=>{
  const {Control}=await import("../src/control.js");
  const ctx=await c.register("U",{kind:"public",acknowledge:true});
  const ref=v.put("U","secret",{value:"PASSWORD-EXPIRED",revision:0,operation_id:"login",location:"body",pointer:"/password",context_ref:ctx.context_ref,context_generation:ctx.generation});
  const control=new Control({} as any,v,e,randomBytes(32),undefined,undefined,undefined,c);
  const original=control.resolver("U","login",ctx.context_ref);
  const resolver={...original,secret:async(r:string,l:string,p:string)=>{
    const value=await original.secret(r,l,p);
    v.db.prepare("UPDATE records SET expires=1 WHERE principal=? AND id=?").run("U",ref);return value;
  }};
  await assert.rejects(c.call("U",ctx.context_ref,{operation_id:"login",body:{email:"u@example.com"},
    secret_bindings:[{location:"body",pointer:"/password",secret_ref:ref}]},resolver),{code:"invalid_reference"});
  assert.equal(seen.length,0);
}));
