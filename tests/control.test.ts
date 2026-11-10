import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccessAuth } from "../src/access.js";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Control } from "../src/control.js";
import { Jobs } from "../src/jobs.js";
import { sample } from "./fixtures.js";
import { registry } from "../src/registry.js";

test("control UI authenticates, applies Origin/CSRF, and scopes secrets and results",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"immich-control-"));
  const key=randomBytes(32),v=new Vault(directory,key,"test",":memory:");
  const config={issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.com"};
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);jwk.kid="test";
  const access=new AccessAuth(config,createLocalJWKSet({keys:[jwk]}));
  const sign=(subject:string)=>new SignJWT({sub:subject,iss:config.issuer,aud:config.audience,exp:Math.floor(Date.now()/1000)+300}).setProtectedHeader({alg:"RS256",kid:"test"}).sign(privateKey);
  const assertion=await sign("A"),otherAssertion=await sign("B"),principal=await access.authenticate(assertion);
  const e=new Executor("http://immich/api",v,(async(_url:any,init:any)=>{
    assert.equal(init.headers.get("x-api-key"),"API-KEY-CANARY");
    if(new URL(String(_url)).pathname==="/api/admin/config"){
      const body=JSON.parse(String(init.body));assert.equal(body.oauth.clientSecret,"");assert.equal(body.notifications.smtp.transport.password,"");return Response.json(body);
    }
    return Response.json(sample(registry.schemas.ApiKeyResponseDto!));
  }) as typeof fetch);
  const jobs=new Jobs(v,e,()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}}),{autoStart:false});
  const control=new Control(access,v,e,key,undefined,jobs);
  const get=()=>control.fetch(new Request(config.publicOrigin+"/connect",{headers:{"cf-access-jwt-assertion":assertion}}));
  try{
    assert.equal((await control.fetch(new Request(config.publicOrigin+"/connect"))).status,401);
    const page=await get();const text=await page.text();
    assert.equal(page.headers.get("cache-control"),"no-store");
    assert.ok(!text.includes("API-KEY-CANARY"));
    const cookie=page.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(page.headers.get("set-cookie")!,/Secure; HttpOnly; SameSite=Strict/);
    const csrf=cookie.slice(cookie.indexOf("=")+1);
    const post=(path:string,values:Record<string,string>,origin=config.publicOrigin,jwt=assertion)=>control.fetch(new Request(config.publicOrigin+path,{
      method:"POST",headers:{"cf-access-jwt-assertion":jwt,origin,cookie,"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({csrf,...values})}));
    assert.equal((await post("/connect/key",{revision:"0",key:"API-KEY-CANARY"},"https://evil.example")).status,403);
    assert.equal((await post("/connect/key",{revision:"0",key:"API-KEY-CANARY",csrf:"bad"})).status,403);
    assert.equal((await post("/connect/key",{revision:"0",key:"API-KEY-CANARY"})).status,303);
    assert.equal(v.credential(principal).key,"API-KEY-CANARY");
    const job=await jobs.submit(principal,{operation_id:"getServerVersion"});
    const recoveryHtml=await (await get()).text();
    assert.ok(recoveryHtml.includes(job.job_ref));assert.ok(recoveryHtml.includes(job.request_id));
    assert.equal((await post("/connect/job/cancel",{job_ref:job.job_ref})).status,303);
    assert.equal(jobs.get(principal,job.job_ref).state,"cancelled");
    const receipt=await post("/connect/secret",{operation_id:"login",pointer:"/password",value:"PASSWORD-CANARY"});
    assert.equal(receipt.status,200);
    const receiptHtml=await receipt.text();assert.ok(!receiptHtml.includes("PASSWORD-CANARY"));
    const ref=receiptHtml.match(/<code>(secret_[^<]+)<\/code>/)![1]!;
    assert.equal(await control.resolver(principal,"login").secret(ref,"body","/password"),"PASSWORD-CANARY");
    await assert.rejects(control.resolver(principal,"changePassword").secret(ref,"body","/password"));
    const secretInput=text.match(/<input[^>]*name="value"[^>]*>/)![0];assert.doesNotMatch(secretInput,/\brequired\b/);
    const clearBody=sample(registry.schemas.AdminConfigDto!),clearBindings=[];
    for(const pointer of ["/oauth/clientSecret","/notifications/smtp/transport/password"]){
      const response=await post("/connect/secret",{operation_id:"updateAdminConfig",pointer,value:""});assert.equal(response.status,200);
      const clearRef=(await response.text()).match(/<code>(secret_[^<]+)<\/code>/)![1]!;
      assert.equal(await control.resolver(principal,"updateAdminConfig").secret(clearRef,"body",pointer),"");
      clearBindings.push({location:"body" as const,pointer,secret_ref:clearRef});
    }
    delete clearBody.oauth.clientSecret;delete clearBody.notifications.smtp.transport.password;
    const cleared=await e.call(principal,{operation_id:"updateAdminConfig",body:clearBody,secret_bindings:clearBindings},control.resolver(principal,"updateAdminConfig"));
    assert.equal(cleared.upstream?.status,200);
    const otherPrincipal=await access.authenticate(otherAssertion);
    await assert.rejects(control.resolver(otherPrincipal,"login").secret(ref,"body","/password"));
    const raw=await v.capture(principal,(async function*(){yield Buffer.from("RAW-SECRET-CANARY");})(),1000);
    const resultRef=v.put(principal,"result",{revision:1,display:{data:{secret:{secret_ref:ref}}},raw});
    assert.deepEqual(control.readResult(principal,resultRef,"/data/secret"),{secret_ref:ref});
    assert.throws(()=>control.readResult(otherPrincipal,resultRef));
    const download=await post("/connect/raw",{result_ref:resultRef});
    assert.equal(download.headers.get("content-disposition"),'attachment; filename="immich-original.bin"');
    assert.equal(download.headers.get("x-immich-original-completeness"),"complete");
    assert.equal(Number(download.headers.get("content-length")),Buffer.byteLength("RAW-SECRET-CANARY"));
    assert.equal(await download.text(),"RAW-SECRET-CANARY");
    assert.equal((await post("/connect/raw",{result_ref:resultRef},config.publicOrigin,otherAssertion)).status,403);
    const partial=await v.capture(principal,(async function*(){yield Buffer.from("PARTIAL-CANARY");throw Error("synthetic interruption");})(),1000,undefined,undefined,true);
    const partialRef=v.put(principal,"result",{revision:1,display:{state:"outcome_unknown",data:null},raw:partial});
    const partialHtml=await (await get()).text();
    assert.ok(partialHtml.includes("Incomplete transfer: only received bytes"));
    assert.ok(!partialHtml.includes("PARTIAL-CANARY"));
    const partialDownload=await post("/connect/raw",{result_ref:partialRef});
    assert.equal(partialDownload.headers.get("content-disposition"),'attachment; filename="immich-original.partial.bin"');
    assert.equal(partialDownload.headers.get("x-immich-original-completeness"),"incomplete");
    assert.equal(partialDownload.headers.get("x-immich-received-sha256"),partial.sha256);
    assert.equal(Number(partialDownload.headers.get("content-length")),Buffer.byteLength("PARTIAL-CANARY"));
    assert.equal(await partialDownload.text(),"PARTIAL-CANARY");
    assert.equal((await post("/connect/raw",{result_ref:partialRef},config.publicOrigin,otherAssertion)).status,403);
    const legacy=v.get(principal,raw.raw_ref,"raw");delete legacy.transfer_complete;
    v.put(principal,"raw",legacy,undefined,raw.raw_ref);
    assert.ok((await (await get()).text()).includes("Transfer completeness was not recorded"));
    const legacyDownload=await post("/connect/raw",{result_ref:resultRef});
    assert.equal(legacyDownload.headers.get("content-disposition"),'attachment; filename="immich-original.unverified.bin"');
    assert.equal(legacyDownload.headers.get("x-immich-original-completeness"),"unknown");
    assert.equal(await legacyDownload.text(),"RAW-SECRET-CANARY");
    const encodedBytes=gzipSync(Buffer.from("ENCODED-RAW-CANARY"));
    const packed=await v.capture(principal,(async function*(){yield encodedBytes;})(),1000);
    const packedRef=v.put(principal,"result",{revision:1,display:{data:null},raw:{...packed,content_encoding:"gzip"}});
    const packedHtml=await (await get()).text();assert.ok(packedHtml.includes("Original HTTP content encoding: gzip"));
    assert.ok(!packedHtml.includes("ENCODED-RAW-CANARY"));
    const packedDownload=await post("/connect/raw",{result_ref:packedRef});
    assert.equal(packedDownload.headers.get("content-disposition"),'attachment; filename="immich-original.encoded.bin"');
    assert.equal(packedDownload.headers.get("x-immich-original-content-encoding"),"gzip");
    assert.equal(packedDownload.headers.get("content-encoding"),null);
    assert.deepEqual(Buffer.from(await packedDownload.arrayBuffer()),encodedBytes);
    assert.equal((await post("/connect/disconnect",{revision:"1"})).status,303);
    assert.throws(()=>control.readResult(principal,resultRef));
  }finally{await jobs.close();v.close();await rm(directory,{recursive:true,force:true});}
});
