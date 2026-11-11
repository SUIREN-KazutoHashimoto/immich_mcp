import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {Application} from "../src/app.js";
import {APPLICATION_VERSION,observedImmichVersion,serverInfoDescriptor} from "../src/server-info.js";
import {descriptors} from "../src/tools.js";
import {validator} from "../src/schema.js";

test("authenticated MCP server information distinguishes application/API versions without keys, upstream calls or private data",{timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-server-info-")),key=randomBytes(32);
  const issuer="https://team.cloudflareaccess.com",origin="https://mcp.example.test";
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="server-info";
  const token=await new SignJWT({iss:issuer,aud:"test",sub:"PRIVATE-SUBJECT-CANARY",exp:Math.floor(Date.now()/1000)+120})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
  let version:any={major:3,minor:3,patch:6,prerelease:null},hits=0;
  const app=await Application.create({upstream:"http://private-immich-canary/api",publicOrigin:origin,issuer,audience:"test",
    jwksUrl:issuer+"/cdn-cgi/access/certs",directory:root,masterKey:key,host:"127.0.0.1",port:0},
    {databasePath:":memory:",versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0,jwks:createLocalJWKSet({keys:[jwk]}),
      http:async()=>{hits++;if(!version)throw Error("PRIVATE-UPSTREAM-ERROR");return Response.json(version);}});
  let client:Client|undefined;
  try{
    app.vault.replaceBinding("OTHER-PRINCIPAL-CANARY","PRIVATE-API-KEY-CANARY","PRIVATE-USER-ID-CANARY",0);
    let id=0;
    const rpc=async(method:string,params:any)=>{
      const response=await app.fetch(new Request(origin+"/mcp",{method:"POST",headers:{"content-type":"application/json",
        accept:"application/json, text/event-stream","cf-access-jwt-assertion":token,"mcp-protocol-version":"2025-11-25"},
        body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})}));
      assert.equal(response.status,200);const text=await response.text();
      return text.trim().startsWith("{")?JSON.parse(text):JSON.parse(text.split("\n").filter(s=>s.startsWith("data:")).at(-1)!.slice(5));
    };
    const initialized=await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"server-info-test",version:"1"}});
    assert.equal(initialized.result.serverInfo.version,APPLICATION_VERSION);
    const listing=(await rpc("tools/list",{})).result.tools;
    const descriptor=listing.find((t:any)=>t.name==="immich_get_server_info");
    assert.ok(descriptor);assert.equal(descriptor.annotations.readOnlyHint,true);assert.equal(descriptor.annotations.destructiveHint,false);
    const before=hits,reply=await rpc("tools/call",{name:"immich_get_server_info",arguments:{}});
    assert.equal(reply.error,undefined);assert.equal(reply.result.isError,undefined);
    const info=reply.result.structuredContent;validator(serverInfoDescriptor.outputSchema,{})(info);
    assert.equal(info.server.version,APPLICATION_VERSION);assert.equal(info.server.build_revision,null);
    assert.equal(info.immich.api_contract_version,"3.3.5");assert.deepEqual(info.immich.supported_versions,["3.3.5","3.3.6"]);
    assert.equal(info.immich.observed_version,"3.3.6");assert.equal(info.immich.state,"ok");
    assert.equal(info.readiness.ready,true);assert.equal(info.readiness.local_checks.database,"ok");
    assert.equal(info.capabilities.tool_count,11);assert.deepEqual(info.capabilities.tools,descriptors.map(t=>t.name));
    assert.equal(listing.length,11);assert.equal(hits,before,"server information must not trigger upstream requests");
    assert.ok(Number.isFinite(Date.parse(info.server.started_at)));assert.ok(info.server.uptime_seconds>=0);
    assert.deepEqual(JSON.parse(reply.result.content[0].text),info);
    const encoded=JSON.stringify(reply);
    for(const hidden of [root,key.toString("hex"),token,"PRIVATE-API-KEY-CANARY","PRIVATE-USER-ID-CANARY","OTHER-PRINCIPAL-CANARY",
      "PRIVATE-SUBJECT-CANARY","private-immich-canary","cloudflareaccess.com","PRIVATE-UPSTREAM-ERROR"])assert.ok(!encoded.includes(hidden),hidden);
    const principal=await app.access.authenticate(token);assert.equal(app.vault.binding(principal),undefined);
    const again=await app.tools.invoke("ANOTHER-UNREGISTERED-CALLER","immich_get_server_info",{});
    assert.equal(again.server.started_at,info.server.started_at);assert.ok(again.server.uptime_seconds>=info.server.uptime_seconds);
    const unauthorized=await app.fetch(new Request(origin+"/mcp",{method:"POST",body:"{}"}));assert.equal(unauthorized.status,401);
    const invalid=await rpc("tools/call",{name:"immich_get_server_info",arguments:{include_secrets:true}});
    assert.ok(invalid.error||invalid.result?.isError);
    version={major:4,minor:0,patch:0,prerelease:null};await app.checkVersion();
    let degraded=await app.tools.invoke(principal,"immich_get_server_info",{});
    assert.equal(degraded.immich.observed_version,"4.0.0");assert.equal(degraded.immich.state,"version_mismatch");assert.equal(degraded.readiness.ready,false);
    version=null;await app.checkVersion();app.localHealth={...app.localHealth,storage:"error",private_path:"PRIVATE-PATH-CANARY"} as any;app.cleanupState="error";
    degraded=await app.tools.invoke(principal,"immich_get_server_info",{});
    assert.equal(degraded.immich.observed_version,null);assert.equal(degraded.immich.state,"unreachable");
    assert.equal(degraded.readiness.local_checks.storage,"error");assert.equal(degraded.readiness.storage_cleanup,"error");
    assert.ok(!JSON.stringify(degraded).includes("PRIVATE-PATH-CANARY"));validator(serverInfoDescriptor.outputSchema,{})(degraded);
    client=new Client({name:"server-info-modern",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
    const transport=new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:{"cf-access-jwt-assertion":token}},
      fetch:async(input,init)=>app.fetch(new Request(input,init))});
    await client.connect(transport);
    const modern:any=await client.callTool({name:"immich_get_server_info",arguments:{}});
    assert.equal(modern.isError,undefined);assert.equal(modern.structuredContent.server.version,APPLICATION_VERSION);
    assert.equal(modern.structuredContent.readiness.ready,false);
  }finally{await client?.close();await app.close();await rm(root,{recursive:true,force:true});}
});

test("observed upstream versions are bounded semver data and cannot expose arbitrary upstream strings",()=>{
  assert.equal(observedImmichVersion({major:3,minor:3,patch:6,prerelease:null}),"3.3.6");
  assert.equal(observedImmichVersion({major:3,minor:3,patch:7,prerelease:"beta.1"}),"3.3.7-beta.1");
  for(const prerelease of ["https://private.example/token","secret\nvalue","a".repeat(65),{},true])
    assert.equal(observedImmichVersion({major:3,minor:3,patch:7,prerelease}),null);
  assert.equal(observedImmichVersion({major:-1,minor:3,patch:7,prerelease:null}),null);
});

test("application, package, production label and built metadata agree on the MCP release",async()=>{
  const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  const docker=await readFile(new URL("../Dockerfile",import.meta.url),"utf8");
  const built=JSON.parse(await readFile(new URL("../dist/src/build-info.json",import.meta.url),"utf8"));
  assert.equal(pkg.version,APPLICATION_VERSION);assert.ok(docker.includes('org.opencontainers.image.version="'+APPLICATION_VERSION+'"'));
  assert.equal(built.version,APPLICATION_VERSION);assert.ok(built.revision===null||/^[0-9a-f]{40}$/.test(built.revision));
});
