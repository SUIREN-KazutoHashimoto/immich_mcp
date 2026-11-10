import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessAuth } from "../src/access.js";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Contexts } from "../src/contexts.js";
import { Control } from "../src/control.js";
import { sample,uuid } from "./fixtures.js";
import { registry } from "../src/registry.js";
import { Staging } from "../src/staging.js";
import { Uploads } from "../src/uploads.js";
import { DownloadPolicy } from "../src/download.js";

async function fixture(run:(f:{v:Vault;c:Contexts;control:Control;p:string;assertion:string;post:(path:string,values:Record<string,string>,origin?:string)=>Promise<Response>;get:()=>Promise<Response>})=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-context-ui-")),key=randomBytes(32),v=new Vault(dir,key,"test",":memory:");
  const config={issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.com"};
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="test";
  const access=new AccessAuth(config,createLocalJWKSet({keys:[jwk]}));
  const assertion=await new SignJWT({sub:"U",iss:config.issuer,aud:config.audience,exp:Math.floor(Date.now()/1000)+300}).setProtectedHeader({alg:"RS256",kid:"test"}).sign(privateKey);
  const p=await access.authenticate(assertion);
  const e=new Executor("http://immich/api",v,(async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname,h=new Headers(init.headers);
    if(path==="/api/api-keys/me"){assert.equal(h.get("x-api-key"),"key-A");return Response.json(sample(registry.schemas.ApiKeyResponseDto!));}
    if(path==="/api/api-keys/"+uuid){assert.equal(h.get("authorization"),"Bearer SESSION-UI-CANARY");assert.equal(h.get("x-api-key"),null);return Response.json(sample(registry.schemas.ApiKeyResponseDto!));}
    if(path==="/api/oauth/authorize")return Response.json({url:"https://provider.example/authorize?state=STATE-UI-CANARY"},{status:201,headers:{"set-cookie":"immich_oauth_state=STATE-UI-CANARY; Path=/api"}});
    if(path==="/api/server/version")return Response.json({major:3,minor:3,patch:5,prerelease:null});
    return Response.json({...sample(registry.schemas.LoginResponseDto!),accessToken:"SESSION-UI-CANARY"},{status:201});
  }) as typeof fetch);
  const c=new Contexts(v,e,config.publicOrigin),s=new Staging(v,new DownloadPolicy([])),u=new Uploads(s);
  const control=new Control(access,v,e,key,s,undefined,u,c);
  const get=()=>control.fetch(new Request(config.publicOrigin+"/connect",{headers:{"cf-access-jwt-assertion":assertion}}));
  const page=await get(),cookie=page.headers.get("set-cookie")!.split(";")[0]!,csrf=cookie.slice(cookie.indexOf("=")+1);
  const post=(path:string,values:Record<string,string>,origin=config.publicOrigin)=>control.fetch(new Request(config.publicOrigin+path,
    {method:"POST",headers:{"cf-access-jwt-assertion":assertion,origin,cookie,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({csrf,...values})}));
  try{await run({v,c,control,p,assertion,post,get});}finally{v.close();await rm(dir,{recursive:true,force:true});}
}
const ref=(text:string,prefix:string)=>text.match(new RegExp("<code>("+prefix+"_[^<]+)</code>"))![1]!;
test("control UI connects explicit contexts, scopes secrets and originals, and separately enables general session mode",()=>fixture(async({v,c,control,p,post,get})=>{
  const page=await (await get()).text();
  assert.ok(page.includes("API-key permissions do not apply"));assert.ok(page.includes('id="upload-button"'));
  assert.equal((await post("/connect/context/register",{kind:"public",ttl_seconds:"3600",acknowledge:"1"},"https://evil.example")).status,403);
  assert.equal((await post("/connect/context/register",{kind:"public",ttl_seconds:"3600"})).status,400);
  const registered=await post("/connect/context/register",{kind:"public",ttl_seconds:"3600",acknowledge:"1"});
  assert.equal(registered.status,200);const publicRef=ref(await registered.text(),"auth_context");
  const secret=await post("/connect/secret",{operation_id:"login",pointer:"/password",value:"PASSWORD-UI-CANARY",context_ref:publicRef});
  const secretHtml=await secret.text();assert.equal(secret.status,200);assert.ok(!secretHtml.includes("PASSWORD-UI-CANARY"));
  const passwordRef=ref(secretHtml,"secret");
  const result=await c.call(p,publicRef,{operation_id:"login",body:{email:"u@example.com"},
    secret_bindings:[{location:"body",pointer:"/password",secret_ref:passwordRef}]},control.resolver(p,"login",publicRef));
  assert.ok(!JSON.stringify(result).includes("SESSION-UI-CANARY"));
  assert.ok(!JSON.stringify(control.readResult(p,result.result_ref!,"/data")).includes("SESSION-UI-CANARY"));
  const original=await post("/connect/raw",{result_ref:result.result_ref!});
  assert.equal((await original.json()).accessToken,"SESSION-UI-CANARY");
  v.replaceBinding(p,"key-A",uuid,0);
  assert.ok(control.readResult(p,result.result_ref!));
  const session=await post("/connect/context/register",{kind:"session",source_result_ref:result.result_ref!,ttl_seconds:"3600",acknowledge:"1"});
  assert.equal(session.status,200);const sessionRef=ref(await session.text(),"auth_context"),generation=c.describe(p,sessionRef).generation;
  await assert.rejects(c.call(p,sessionRef,{operation_id:"getServerVersion"},control.resolver(p,"getServerVersion",sessionRef)),{code:"context_purpose"});
  assert.equal((await post("/connect/context/mode",{context_ref:sessionRef,generation:String(generation),general:"1"})).status,400);
  assert.equal((await post("/connect/context/mode",{context_ref:sessionRef,generation:String(generation),general:"1",acknowledge:"1"})).status,303);
  assert.equal((await c.call(p,sessionRef,{operation_id:"getServerVersion"},control.resolver(p,"getServerVersion",sessionRef))).upstream?.status,200);
  assert.equal((await post("/connect/context/revoke",{context_ref:publicRef,generation:"1"})).status,303);
  assert.throws(()=>control.readResult(p,result.result_ref!));
}));
test("OAuth control-plane callback never renders the authorization code and reuses only its opaque receipt",()=>fixture(async({v,c,control,p,assertion,post})=>{
  const response=await post("/connect/context/register",{kind:"public",ttl_seconds:"3600",acknowledge:"1"});
  const contextRef=ref(await response.text(),"auth_context");
  const started=await post("/connect/context/oauth",{context_ref:contextRef,generation:"1"});
  assert.equal(started.status,303);assert.match(started.headers.get("location")!,/^https:\/\/provider.example/);
  const callback=await control.fetch(new Request(c.callbackUrl+"?code=CODE-UI-CANARY&state=STATE-UI-CANARY",{headers:{"cf-access-jwt-assertion":assertion}}));
  const html=await callback.text();assert.equal(callback.status,200);assert.ok(!html.includes("CODE-UI-CANARY"));
  const callbackRef=ref(html,"oauth_callback");
  const result=await c.call(p,contextRef,{operation_id:"finishOAuth",body:{}},control.resolver(p,"finishOAuth",contextRef),{oauth_callback_ref:callbackRef});
  assert.equal(result.upstream?.status,201);assert.ok(!JSON.stringify(result).includes("CODE-UI-CANARY"));
  const bad=await control.fetch(new Request(c.callbackUrl+"?code=NEVER-RENDER&state=wrong",{headers:{"cf-access-jwt-assertion":assertion}}));
  assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes("NEVER-RENDER"));
}));
