import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { prepare } from "../src/serializer.js";
import { uuid } from "./fixtures.js";

async function withVault(run:(v:Vault)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),"immich-boundary-"));
  const vault=new Vault(dir,randomBytes(32),"test",":memory:");
  try{vault.replaceBinding("A","key-A",uuid,0);await run(vault);}
  finally{vault.close();await rm(dir,{recursive:true,force:true});}
}
test("playback and original Range 206 and 416 preserve exact bytes, Content-Range and length",()=>withVault(async v=>{
  for(const operation_id of ["playAssetVideo","downloadAsset"])for(const status of [206,416]){
    const bytes=Uint8Array.of(0,255,128,20);
    const e=new Executor("http://immich/api",v,(async(url:any,init:any)=>{
      assert.equal(init.headers.get("range"),"bytes=0-3");
      return new Response(bytes,{status,headers:{"content-type":"video/mp4","content-range":"bytes 0-3/40","content-length":"4","accept-ranges":"bytes"}});
    }) as typeof fetch);
    const r=await e.call("A",{operation_id,path:{id:uuid},headers:{Range:"bytes=0-3"}});
    assert.equal(r.upstream?.status,status);
    assert.equal(r.upstream?.headers["content-range"],"bytes 0-3/40");
    assert.equal(r.upstream?.headers["content-length"],"4");
    const stored=v.get("A",r.result_ref!,"result");
    assert.deepEqual(new Uint8Array(await new Response(v.rawStream("A",stored.raw.raw_ref) as any).arrayBuffer()),bytes);
  }
}));
test("redirects and cookies never expose secret URLs or automatically follow",()=>withVault(async v=>{
  let count=0;
  const e=new Executor("http://immich/api",v,(async(_url:any,init:any)=>{
    count++;assert.equal(init.redirect,"manual");
    return new Response(null,{status:307,headers:{Location:"app://callback?code=URL-CANARY","Set-Cookie":"session=COOKIE-CANARY; HttpOnly"}});
  }) as typeof fetch);
  const r=await e.call("A",{operation_id:"redirectOAuthToMobile"});
  assert.equal(count,1);assert.equal(r.upstream?.status,307);
  assert.ok(!JSON.stringify(r).includes("CANARY"));
}));
test("parallel principals never share authentication or result references",()=>withVault(async v=>{
  v.replaceBinding("B","key-B",uuid,0);
  const seen:string[]=[];
  const e=new Executor("http://immich/api",v,(async(_url:any,init:any)=>{
    const key=init.headers.get("x-api-key");seen.push(key);
    await new Promise(resolve=>setTimeout(resolve,key==="key-A"?5:1));
    return Response.json({major:3,minor:3,patch:5,prerelease:null});
  }) as typeof fetch);
  const [a,b]=await Promise.all([e.call("A",{operation_id:"getServerVersion"}),e.call("B",{operation_id:"getServerVersion"})]);
  assert.deepEqual(seen,["key-A","key-B"]);
  assert.throws(()=>v.get("B",a.result_ref!,"result"));
  assert.throws(()=>v.get("A",b.result_ref!,"result"));
}));
test("raw passwords rejected; explicit secret references resolved before upstream validation",async()=>{
  await assert.rejects(prepare("http://immich/api",{operation_id:"login",body:{email:"test@example.com",password:"CANARY"}}),{code:"secret_reference_required"});
  const req=await prepare("http://immich/api",{operation_id:"login",body:{email:"test@example.com"},
    secret_bindings:[{location:"body",pointer:"/password",secret_ref:"owned-ref"}]},
    {file:async()=>{throw Error();},secret:async()=>"CANARY"});
  assert.equal(JSON.parse(req.body as string).password,"CANARY");
});
test("key replacement during reference resolution prevents sending stale credentials",()=>withVault(async v=>{
  let sent=false;
  const e=new Executor("http://immich/api",v,(async()=>{sent=true;return new Response();}) as typeof fetch);
  await assert.rejects(e.call("A",{operation_id:"login",body:{email:"test@example.com"},
    secret_bindings:[{location:"body",pointer:"/password",secret_ref:"owned-ref"}]},
    {file:async()=>{throw Error();},secret:async()=>{v.replaceBinding("A","new-key",uuid,1);return "test-password";}}),{code:"credential_conflict"});
  assert.equal(sent,false);
}));

test("self rotation atomically updates local binding and keeps generated secret in encrypted original",()=>withVault(async v=>{
  let sent=0;
  const {registry}=await import("../src/registry.js");
  const {sample}=await import("./fixtures.js");
  const decoded=sample(registry.schemas.ApiKeyCreateResponseDto!);decoded.secret="NEW-KEY-CANARY";
  const e=new Executor("http://immich/api",v,(async()=>{sent++;return Response.json(decoded,{status:201});}) as typeof fetch);
  const r=await e.call("A",{operation_id:"rotateApiKey",path:{id:uuid}});
  assert.equal(sent,1);assert.equal(v.credential("A").key,"NEW-KEY-CANARY");
  assert.equal(v.credential("A").revision,2);assert.ok(!JSON.stringify(r).includes("NEW-KEY-CANARY"));
  const stored=v.get("A",r.result_ref!,"result");
  assert.equal(stored.revision,2);assert.equal(stored.display.result_ref,r.result_ref);
}));
test("upstream 401 and 403 do not cause retries or credential fallback",()=>withVault(async v=>{
  for(const status of [401,403]){
    let sent=0;
    const e=new Executor("http://immich/api",v,(async(_url:any,init:any)=>{
      sent++;assert.equal(init.headers.get("x-api-key"),"key-A");assert.equal(init.headers.get("cookie"),null);
      return Response.json({message:"REFUSAL-CANARY"},{status});
    }) as typeof fetch);
    const r=await e.call("A",{operation_id:"getServerVersion"});
    assert.equal(sent,1);assert.equal(r.upstream?.status,status);assert.ok(!JSON.stringify(r).includes("REFUSAL-CANARY"));
    assert.equal(v.credential("A").key,"key-A");
  }
}));
