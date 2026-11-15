import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import sharp from "sharp";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {Application} from "../src/app.js";
import {registry,operation} from "../src/registry.js";
import {validator} from "../src/schema.js";
import {safeShape} from "../src/projection.js";
import {supportedImmichVersions,compatibilityWarnings} from "../src/immich-version.js";
import {applyImmich341Compatibility} from "../scripts/immich-compatibility.js";
import {sample,uuid} from "./fixtures.js";

const latestBytes=await readFile(new URL("../compatibility/immich-openapi-v3.4.1.json",import.meta.url));
const latest=JSON.parse(latestBytes.toString("utf8"));
const base=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
test("reviewed current/previous response shapes remain typed, while unknown fields and modified sources stay rejected",()=>{
  for(const name of ["ServerFeaturesDto","ServerVersionResponseDto","PublicConfigDto","UserConfigDto","AdminConfigDto","MaintenanceStatusResponseDto"]){
    for(const api of [base,latest]){
      const value=sample(api.components.schemas[name]);
      validator(registry.schemas[name]!,registry.schemas)(value);
      assert.deepEqual(safeShape(value,registry.schemas[name]!),value,name);
    }
  }
  assert.ok(registry.schemas.Permission!.enum.includes("clusterGroup.admin"));
  assert.ok(registry.schemas.Permission!.enum.includes("passkey.read"));
  assert.ok(registry.schemas.ImageFormat!.enum.includes("jxl"));
  assert.throws(()=>safeShape({...sample(registry.schemas.ServerFeaturesDto!),UNREVIEWED_SECRET:"NEVER-EXPOSE"},registry.schemas.ServerFeaturesDto!),{code:"projection_mismatch"});
  assert.equal(registry.operations.length,279);
  assert.throws(()=>operation("finishAuthentication"),{code:"unknown_operation"},"New passkey login workflows are outside the existing API surface");
  const op=operation("clusterGroupRegeneratePeople");
  assert.equal(op.auth.effective_api_key_permission,"clusterGroup.read");
  assert.equal(op.auth.version_overrides[0].effective_api_key_permission,"clusterGroup.admin");
  for(const name of ["createNotification","getNotificationTemplateAdmin","sendTestEmailAdmin"]){
    assert.equal(operation(name).auth.version_overrides[0].admin_only,true);
    assert.equal(operation(name).auth.version_overrides[0].effective_api_key_permission,"notification.create");
  }
  assert.throws(()=>applyImmich341Compatibility(registry.operations,registry.schemas,base,Buffer.concat([latestBytes,Buffer.from(" ")])),/fingerprint/);
});
test("advisory versions are bounded and cannot smuggle arbitrary upstream text into warnings",()=>{
  assert.deepEqual(supportedImmichVersions,["3.3.5","3.3.6","3.4.0","3.4.1"]);
  assert.deepEqual(compatibilityWarnings({state:"ok"}),[]);
  const warnings=compatibilityWarnings({state:"version_mismatch",observed_version:"PRIVATE-URL-AND-KEY"});
  assert.equal(warnings.length,1);assert.equal(warnings[0]!.observed_version,null);
  assert.ok(!JSON.stringify(warnings).includes("PRIVATE-URL-AND-KEY"));
});

async function fixture(run:(f:any)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-compatibility-"));
  const origin="https://mcp.example.test",issuer="https://team.cloudflareaccess.com";
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="compatibility";
  const token=await new SignJWT({iss:issuer,aud:"test",sub:"PRIVATE-USER",exp:Math.floor(Date.now()/1000)+240})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
  let version:any={major:3,minor:4,patch:1,prerelease:null,featureLevel:2},refuse=false,offline=false,versionDuringCall:any;
  const calls:string[]=[];
  const image=await sharp({create:{width:20,height:10,channels:3,background:"red"}}).jpeg().toBuffer();
  let app:Application;
  app=await Application.create({directory:dir,masterKey:randomBytes(32),upstream:"http://immich/api",publicOrigin:origin,
    issuer,audience:"test",jwksUrl:issuer+"/cdn-cgi/access/certs",host:"127.0.0.1",port:0},
    {databasePath:":memory:",versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0,jwks:createLocalJWKSet({keys:[jwk]}),
      http:async(input,init)=>{
        const path=new URL(String(input)).pathname;
        if(path==="/api/server/version")return offline?new Response(null,{status:503}):Response.json(version);
        calls.push(path);assert.equal(new Headers(init?.headers).get("x-api-key"),"PRIVATE-API-KEY");
        assert.equal(new Headers(init?.headers).get("cf-access-jwt-assertion"),null);
        if(versionDuringCall){version=versionDuringCall;versionDuringCall=undefined;await app.checkVersion();}
        if(path.endsWith("/thumbnail"))return new Response(new Uint8Array(image),{headers:{"content-type":"image/jpeg"}});
        if(path==="/api/users/me"&&refuse)return Response.json({message:"denied"},{status:403});
        if(path==="/api/server/features")return Response.json(sample(latest.components.schemas.ServerFeaturesDto));
        if(path==="/api/config")return Response.json(sample(latest.components.schemas.UserConfigDto));
        if(path==="/api/public/config")return Response.json(sample(latest.components.schemas.PublicConfigDto));
        if(path==="/api/search/random")return Response.json([{...sample({$ref:"#/components/schemas/AssetResponseDto"}),id:uuid,type:"IMAGE"}]);
        const schema=path==="/api/api-keys/me"?operation("getMyApiKey").definition.responses["200"].content["application/json"].schema:
          operation("getMyUser").definition.responses["200"].content["application/json"].schema;
        return Response.json(sample(schema));
      }});
  const principal=await app.access.authenticate(token);app.vault.replaceBinding(principal,"PRIVATE-API-KEY",uuid,0);
  let id=0;const rpc=async(method:string,params:any)=>{
    const response=await app.fetch(new Request(origin+"/mcp",{method:"POST",headers:{"cf-access-jwt-assertion":token,
      "content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":"2025-11-25"},
      body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})}));
    assert.equal(response.status,200);const text=await response.text();
    const reply=JSON.parse(text.trim().startsWith("{")?text:text.split("\n").filter(l=>l.startsWith("data:")).at(-1)!.slice(5));
    assert.equal(reply.error,undefined);return reply.result;
  };
  const call=(name:string,args:any={})=>rpc("tools/call",{name,arguments:args});
  const setVersion=async(value:any)=>{offline=false;version=value;await app.checkVersion();};
  try{
    await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"compatibility-test",version:"1"}});
    await run({app,origin,token,principal,calls,call,setVersion,
      setRefuse:(v:boolean)=>{refuse=v;},setOffline:async()=>{offline=true;await app.checkVersion();},
      recoverDuringNextCall:()=>{versionDuringCall={major:3,minor:4,patch:1,prerelease:null,featureLevel:2};}});
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
}
const assertWarning=(reply:any)=>{
  assert.ok(reply.content.some((part:any)=>part.type==="text"&&part.text.includes("unverified_immich_version")));
  if(reply.structuredContent)assert.equal(reply.structuredContent.compatibility_warnings[0].code,"unverified_immich_version");
  assert.ok(!JSON.stringify(reply).includes("PRIVATE-API-KEY"));
};
test("latest Immich feature levels, new feature/config fields and previous reviewed versions execute without compatibility warnings",()=>fixture(async({app,call,setVersion,origin}:any)=>{
  for(const version of [{major:3,minor:3,patch:5,prerelease:null},{major:3,minor:3,patch:6,prerelease:null},
    {major:3,minor:4,patch:0,prerelease:null,featureLevel:2},{major:3,minor:4,patch:1,prerelease:null,featureLevel:2}]){
    await setVersion(version);assert.equal(app.health.state,"ok");
    const reply=await call("immich_api_call",{operation_id:"getServerVersion",execution_mode:"sync"});
    assert.equal(reply.isError,undefined);assert.deepEqual(reply.structuredContent.data,version);
    assert.equal(reply.structuredContent.compatibility_warnings,undefined);
  }
  const features=await call("immich_api_call",{operation_id:"getServerFeatures",execution_mode:"sync"});
  assert.equal(features.isError,undefined);assert.equal(features.structuredContent.data.backups,false);
  const config=await call("immich_api_call",{operation_id:"getUserConfig",execution_mode:"sync"});
  assert.equal(config.isError,undefined);assert.deepEqual(config.structuredContent.data.passkey,{enabled:false});
  const publicConfig=await call("immich_api_call",{operation_id:"getPublicConfig",execution_mode:"sync"});
  assert.equal(publicConfig.isError,undefined);assert.deepEqual(publicConfig.structuredContent.data.passkey,{enabled:false});
  assert.equal(Object.hasOwn(publicConfig.structuredContent.data,"theme"),false);
  assert.equal((await app.fetch(new Request(origin+"/health/ready"))).status,200);
}));
test("unreviewed stable and prerelease servers remain ready with warnings in native JSON, queued jobs, errors and SDK results",()=>fixture(async(f:any)=>{
  const {app,call,setVersion,origin,calls}=f;
  for(const version of [{major:4,minor:0,patch:0,prerelease:null},{major:3,minor:4,patch:2,prerelease:1},{major:3,minor:4,patch:2,prerelease:"rc.1"}]){
    await setVersion(version);assert.equal(app.health.state,"version_mismatch");
    assert.equal((await app.fetch(new Request(origin+"/health/ready"))).status,200);
    const connection=await call("immich_get_connection");assertWarning(connection);
    assert.equal(connection.structuredContent.binding_state,"active");
    const before=calls.length;
    const result=await call("immich_api_call",{operation_id:"getMyUser",execution_mode:"sync"});
    assert.equal(result.isError,undefined);assertWarning(result);assert.equal(calls.length,before+1);
    const queued=await call("immich_api_call",{operation_id:"searchRandom",body:{size:1},execution_mode:"async"});
    assert.equal(queued.structuredContent.state,"queued");assertWarning(queued);await app.jobs.idle();
    const done=await call("immich_get_job",{job_ref:queued.structuredContent.job_ref});
    assert.equal(done.structuredContent.state,"completed");assertWarning(done);
    f.setRefuse(true);
    const rejected=await call("immich_api_call",{operation_id:"getMyUser",execution_mode:"sync"});
    assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.upstream.status,403);assertWarning(rejected);
    f.setRefuse(false);
    const invalid=await call("immich_read_image",{result_ref:"result_"+uuid});assert.equal(invalid.isError,true);assertWarning(invalid);
  }
  const client=new Client({name:"compatibility-modern-sdk",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:{"cf-access-jwt-assertion":f.token}},fetch:async(input,init)=>app.fetch(new Request(input,init))}));
    const result:any=await client.callTool({name:"immich_get_server_info",arguments:{}});
    assert.equal(result.isError,undefined);assertWarning(result);assert.equal(result.structuredContent.readiness.ready,true);
  }finally{await client.close();}
}));
test("image content and previews survive advisory warnings without a metadata-only structured result",()=>fixture(async({call,setVersion}:any)=>{
  await setVersion({major:5,minor:0,patch:0,prerelease:null});
  const result=await call("immich_get_image",{source:"asset",asset_id:uuid});
  assert.equal(result.isError,undefined);assert.equal(result.structuredContent,undefined);assertWarning(result);
  const image=result.content.find((p:any)=>p.type==="image");assert.ok(image);
  assert.deepEqual(result._meta.image_content,image);
  const read=await call("immich_read_image",{result_ref:result._meta.image_info.result_ref});
  assert.equal(read.isError,undefined);assertWarning(read);
  assert.deepEqual(read.content.find((p:any)=>p.type==="image"),image);
}));
test("in-flight notices survive version recovery, while unreachable upstream and storage failures still block protected execution",()=>fixture(async(f:any)=>{
  const {app,call,setVersion,origin,calls}=f;
  await setVersion({major:4,minor:0,patch:0,prerelease:null});f.recoverDuringNextCall();
  const result=await call("immich_api_call",{operation_id:"getMyUser",execution_mode:"sync"});
  assert.equal(app.health.state,"ok");assert.equal(result.isError,undefined);assertWarning(result);
  const next=await call("immich_get_server_info");assert.equal(next.structuredContent.compatibility_warnings,undefined);
  await f.setOffline();const before=calls.length;
  assert.equal((await app.fetch(new Request(origin+"/health/ready"))).status,503);
  const blocked=await call("immich_api_call",{operation_id:"getMyUser",execution_mode:"sync"});
  assert.equal(blocked.isError,true);assert.equal(calls.length,before);
  await setVersion({major:4,minor:0,patch:0,prerelease:null});
  app.localHealth={...app.localHealth,storage:"error"};
  const local=await call("immich_get_image",{source:"asset",asset_id:uuid});
  assert.equal(local.isError,true);assert.equal(calls.length,before);
}));

test("an unverified upstream still permits authenticated CSRF-protected API-key registration",()=>fixture(async({app,origin,token,principal,call,setVersion,calls}:any)=>{
  await setVersion({major:4,minor:0,patch:0,prerelease:null});
  const page=await app.fetch(new Request(origin+"/connect",{headers:{"cf-access-jwt-assertion":token}}));
  assert.equal(page.status,200);const cookie=page.headers.get("set-cookie")!.split(";")[0]!,csrf=cookie.slice(cookie.indexOf("=")+1);
  const revision=String(app.vault.binding(principal)!.revision);
  const post=(site:string)=>app.fetch(new Request(origin+"/connect/key",{method:"POST",headers:{
    "cf-access-jwt-assertion":token,origin:site,cookie,"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({csrf,revision,key:"PRIVATE-API-KEY"})}));
  assert.equal((await post("https://other.example")).status,403);
  assert.equal((await post(origin)).status,303);
  assert.equal(calls.filter((p:string)=>p==="/api/api-keys/me").length,1);
  assert.equal(app.vault.binding(principal)!.revision,Number(revision)+1);
  const connection=await call("immich_get_connection");assertWarning(connection);
  assert.equal(connection.structuredContent.binding_state,"active");
}));
