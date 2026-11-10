import test from "node:test";
import assert from "node:assert/strict";
import { createServer,request as nodeRequest } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { Application } from "../src/app.js";
import { serve } from "../src/http.js";
import { DownloadPolicy } from "../src/download.js";
import { sample,uuid } from "./fixtures.js";
import { registry } from "../src/registry.js";
import { waitForTestJob } from "./job-wait.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const publicOrigin="https://mcp.example.test",idB="22222222-2222-4222-8222-222222222222",fileBytes=Buffer.from([0,255,10,128]);
const toolData=(reply:any)=>{
  assert.equal(reply.error,undefined,"RPC protocol error");
  assert.ok(reply.result?.structuredContent,"Tool did not return structured content: "+JSON.stringify(reply.result?.content));
  return reply.result.structuredContent;
};
test("native HTTP serves nine SDK tools, principal isolation, files, context jobs and cancellation",{timeout:90000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-http-"));
  let version={major:3,minor:3,patch:5,prerelease:null},versionStatus=200,searchHits=0,uploadHits=0,syncMalformed=false;
  let started!:()=>void,release!:()=>void;
  const startedSearch=new Promise<void>(r=>{started=r;}),holdSearch=new Promise<void>(r=>{release=r;});
  const seen:{path:string;key:string|undefined;authorization:string|undefined}[]=[];
  const upstream=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url!,"http://immich"),parts:Buffer[]=[];
      for await(const c of req)parts.push(c);
      const body=Buffer.concat(parts);
      assert.equal(req.headers["cf-access-jwt-assertion"],undefined);
      assert.ok(!JSON.stringify(req.headers).includes("CLIENT-BEARER-CANARY"));
      seen.push({path:url.pathname,key:req.headers["x-api-key"] as string|undefined,authorization:req.headers.authorization});
      const json=(value:any,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));};
      if(url.pathname==="/api/server/version"){json(version,versionStatus);return;}
      if(url.pathname==="/api/api-keys/me"){
        json({...sample(registry.schemas.ApiKeyResponseDto!),id:req.headers["x-api-key"]==="key-B"?idB:uuid});return;
      }
      if(url.pathname.startsWith("/api/api-keys/")){
        const id=url.pathname.split("/").at(-1);
        json({...sample(registry.schemas.ApiKeyResponseDto!),id},req.headers.authorization==="Bearer SESSION-A"&&id===uuid?200:403);return;
      }
      if(url.pathname==="/api/sync/ack"){
        json(req.headers.authorization==="Bearer SESSION-A"?sample(registry.schemas.SyncAckDto ?? {}):{message:"UPSTREAM-SECRET-CANARY"},req.headers.authorization==="Bearer SESSION-A"?200:403);return;
      }
      if(url.pathname==="/api/sync/stream"){
        if(req.headers.authorization!=="Bearer SESSION-A"){json({},403);return;}
        res.writeHead(200,{"content-type":"application/jsonlines+json"});
        res.end(JSON.stringify({type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),pinCode:"SYNC-PIN-CANARY"},ack:"AuthUserV2|1"})+"\n"+
          (syncMalformed?"{bad}\n":JSON.stringify({type:"SyncCompleteV1",data:{},ack:"SyncCompleteV1|1"})+"\n"));return;
      }
      if(url.pathname==="/api/assets" && req.method==="POST"){
        uploadHits++;const form=await new Response(new Uint8Array(body),{headers:{"content-type":req.headers["content-type"]!}}).formData();
        assert.deepEqual(Buffer.from(await (form.get("assetData") as File).arrayBuffer()),fileBytes);
        assert.equal(form.get("isFavorite"),"false");
        json(sample(registry.schemas.AssetMediaResponseDto ?? {}),201);return;
      }
      if(url.pathname==="/api/search/metadata"){
        searchHits++;started();await holdSearch;
        if(!res.destroyed)json({});return;
      }
      json({message:"synthetic upstream refusal"},403);
    }catch{if(!res.headersSent)res.writeHead(500);res.end();}
  });
  upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
  const upstreamBase="http://127.0.0.1:"+(upstream.address() as any).port+"/api";
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="local";
  const issuer="https://team.cloudflareaccess.com",audience="app";
  const sign=(sub:string)=>new SignJWT({iss:issuer,aud:audience,sub,exp:Math.floor(Date.now()/1000)+600}).setProtectedHeader({alg:"RS256",kid:"local"}).sign(privateKey);
  const tokenA=await sign("A"),tokenB=await sign("B"),tokenU=await sign("U");
  const policy=new DownloadPolicy(["files.example.test"],async()=>[{address:"8.8.8.8",family:4}],async()=>({
    status:200,mime:"application/octet-stream",length:fileBytes.length,body:(async function*(){yield fileBytes;})(),close:()=>{}}));
  const app=await Application.create({upstream:upstreamBase,publicOrigin,issuer,audience,jwksUrl:issuer+"/cdn-cgi/access/certs",
    directory:dir,masterKey:randomBytes(32),host:"127.0.0.1",port:0},{jwks:createLocalJWKSet({keys:[jwk]}),downloads:policy,databasePath:":memory:",versionIntervalMs:0});
  const http=await serve(app),base="http://127.0.0.1:"+(http.address as any).port;
  const principalA=await app.access.authenticate(tokenA),principalB=await app.access.authenticate(tokenB),principalU=await app.access.authenticate(tokenU);
  app.vault.replaceBinding(principalA,"key-A",uuid,0);app.vault.replaceBinding(principalB,"key-B",idB,0);
  let id=0;
  const request=(path:string,token:string|undefined,body?:any,extra:Record<string,string>={},options:{method?:string;signal?:AbortSignal}={})=>new Promise<Response>((resolve,reject)=>{
    const req=nodeRequest(base+path,{method:options.method ?? (body===undefined?"GET":"POST"),signal:options.signal,agent:false,headers:{
      host:new URL(publicOrigin).host,...(token?{"cf-access-jwt-assertion":token}:{}),
      ...(body!==undefined?{"content-type":"application/json"}:{}),...extra}},res=>{
      const headers=new Headers();
      for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i]!,res.rawHeaders[i+1]!);
      resolve(new Response([204,304].includes(res.statusCode!)?null:Readable.toWeb(res) as ReadableStream<Uint8Array>,
        {status:res.statusCode,headers}));
    });
    req.on("error",reject);req.setTimeout(10000,()=>req.destroy(new Error("Test HTTP timeout")));
    req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const rpc=async(method:string,params:any,token=tokenA)=>{
    const response=await request("/mcp",token,{jsonrpc:"2.0",id:++id,method,params},{"accept":"application/json, text/event-stream","mcp-protocol-version":"2025-11-25","authorization":"Bearer CLIENT-BEARER-CANARY"});
    assert.equal(response.status,200,"MCP HTTP status "+response.status);
    const text=await response.text();
    if(text.trim().startsWith("{"))return JSON.parse(text);
    const lines=text.split("\n").filter(line=>line.startsWith("data:"));
    assert.ok(lines.length>0,"No MCP response data");return JSON.parse(lines.at(-1)!.slice(5).trim());
  };
  const call=(name:string,args:any,token=tokenA)=>rpc("tools/call",{name,arguments:args},token);
  const poll=(ref:string,token=tokenA)=>waitForTestJob(async()=>toolData(await call("immich_get_job",{job_ref:ref},token)));
  try{
    assert.equal((await request("/health/ready",undefined)).status,200);
    const missing=await request("/mcp",undefined,{});assert.equal(missing.status,401);
    assert.ok(missing.headers.get("www-authenticate")!.includes("/.well-known/oauth-protected-resource"));
    assert.equal((await request("/mcp","forged",{})).status,401);
    assert.equal((await request("/mcp",tokenA,{}, {origin:"https://evil.example"})).status,403);
    assert.equal((await request("/mcp",tokenA,{}, {host:"evil.example"})).status,403);
    const metadata=await (await request("/.well-known/oauth-protected-resource",undefined)).json();
    assert.deepEqual(metadata.authorization_servers,[publicOrigin]);
    const init=await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic-client",version:"1"}});
    assert.equal(init.result.serverInfo.name,"immich-mcp");
    const packageInfo=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
    assert.equal(init.result.serverInfo.version,packageInfo.version);
    const listed=await rpc("tools/list",{});assert.equal(listed.result.tools.length,9);
    const connection=toolData(await call("immich_get_connection",{}));assert.equal(connection.binding_state,"active");
    const catalog=toolData(await call("immich_api_catalog",{limit:100}));assert.equal(catalog.total,279);assert.equal(catalog.entries.length,100);
    const described=toolData(await call("immich_api_describe",{operation_ids:["uploadAsset"]}));
    assert.ok(described.result_ref);
    const detail=toolData(await call("immich_read_result",{result_ref:described.result_ref,json_pointer:"/operations/0/operation_id"}));
    assert.equal(detail.data,"uploadAsset");
    assert.equal((await rpc("tools/list",{})).result.tools.length,9);
    const normal=toolData(await call("immich_api_call",{operation_id:"getServerVersion",execution_mode:"sync"}));
    assert.equal(normal.upstream.status,200);assert.equal(normal.auth_context_kind,"api_key");
    const denied=await call("immich_api_call",{operation_id:"getSyncAck",execution_mode:"sync"});
    assert.equal(denied.result.isError,true);assert.equal(toolData(denied).upstream.status,403);
    assert.ok(!JSON.stringify(denied).includes("UPSTREAM-SECRET-CANARY"));
    const publicContext=await app.contexts.register(principalU,{kind:"public",acknowledge:true});
    const publicAck=toolData(await call("immich_api_call_context",{context_ref:publicContext.context_ref,call:{operation_id:"getServerVersion",execution_mode:"async"}},tokenU));
    assert.equal(publicAck.state,"queued");assert.equal(publicAck.auth_context_kind,"public_auth");
    const publicDone=await poll(publicAck.job_ref,tokenU);
    assert.equal(publicDone.state,"completed",JSON.stringify(publicDone.diagnostic ?? publicDone.result?.diagnostic));assert.equal(publicDone.result.auth_context_kind,"public_auth");
    assert.equal(app.vault.binding(principalU),undefined);
    const session=await app.contexts.register(principalA,{kind:"session",credential:"SESSION-A",acknowledge:true});
    const sessionAck=toolData(await call("immich_api_call_context",{context_ref:session.context_ref,call:{operation_id:"getSyncAck",execution_mode:"async"}}));
    assert.equal((await poll(sessionAck.job_ref)).result.auth_context_kind,"session_special");
    const streamArgs={context_ref:session.context_ref,call:{operation_id:"getSyncStream",body:{types:["AuthUsersV2"]},execution_mode:"sync"}};
    const streamed=toolData(await call("immich_api_call_context",streamArgs));
    assert.equal(streamed.state,"completed");assert.equal(streamed.data[0].data.pinCode.secret_ref.startsWith("secret_"),true);
    const streamPage=toolData(await call("immich_read_result",{result_ref:streamed.result_ref,mode:"jsonl"}));
    assert.equal(streamPage.complete,true);assert.equal(streamPage.data.length,2);assert.ok(!JSON.stringify(streamPage).includes("SYNC-PIN-CANARY"));
    syncMalformed=true;
    const malformed=await call("immich_api_call_context",streamArgs);assert.equal(malformed.result.isError,true);assert.equal(toolData(malformed).state,"failed");
    syncMalformed=false;
    const stolen=await call("immich_get_job",{job_ref:sessionAck.job_ref},tokenB);assert.equal(stolen.result.isError,true);
    const files=toolData(await call("immich_stage_files",{files:[{download_url:"https://files.example.test/photo?token=DOWNLOAD-CANARY",file_id:"file-1",file_name:"photo.bin"}]}));
    assert.equal(files.files[0].size_bytes,fileBytes.length);assert.ok(!JSON.stringify(files).includes("DOWNLOAD-CANARY"));
    const upload={operation_id:"uploadAsset",body:{fileCreatedAt:"2026-01-01T00:00:00.000Z",fileModifiedAt:"2026-01-01T00:00:00.000Z",isFavorite:false},
      files:{assetData:{file_ref:files.files[0].file_ref}},execution_mode:"async"};
    assert.equal((await call("immich_api_call",upload,tokenB)).result.isError,true);assert.equal(uploadHits,0);
    const uploaded=toolData(await call("immich_api_call",upload));assert.equal((await poll(uploaded.job_ref)).result.upstream.status,201);
    assert.equal(uploadHits,1);
    const binaryMeta=toolData(await call("immich_read_result",{result_ref:normal.result_ref,mode:"metadata"}));assert.equal(binaryMeta.data.upstream.status,200);
    const search=toolData(await call("immich_api_call",{operation_id:"searchAssets",body:{},execution_mode:"async"}));await startedSearch;
    const cancellation=toolData(await call("immich_cancel_job",{job_ref:search.job_ref}));assert.ok(["cancel_requested","outcome_unknown"].includes(cancellation.state));
    const cancelled=await poll(search.job_ref);assert.equal(cancelled.state,"outcome_unknown");assert.equal(cancelled.sent_upstream,true);assert.equal(searchHits,1);release();
    const modernRequests:any[]=[];
    const sdkFetch:typeof fetch=async(input,init)=>{
      const outgoing=new Request(input,init),url=new URL(outgoing.url);
      assert.equal(url.origin,publicOrigin);
      const text=outgoing.body?await outgoing.text():"";
      const body=text?JSON.parse(text):undefined;
      if(body)modernRequests.push({body,headers:Object.fromEntries(outgoing.headers)});
      return request(url.pathname+url.search,tokenA,body,Object.fromEntries(outgoing.headers),{method:outgoing.method,signal:outgoing.signal});
    };
    const client=new Client({name:"official-client-test",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
    try{
      await client.connect(new StreamableHTTPClientTransport(new URL(publicOrigin+"/mcp"),{fetch:sdkFetch}));
      assert.equal(client.getProtocolEra(),"modern");assert.equal(client.getNegotiatedProtocolVersion(),"2026-07-28");
      assert.ok(client.getDiscoverResult());
      const tools=await client.listTools();assert.equal(tools.tools.length,9);
      const connection:any=await client.callTool({name:"immich_get_connection",arguments:{}});
      assert.equal(connection.structuredContent?.binding_state ?? connection.result?.binding_state,"active");
      const result:any=await client.callTool({name:"immich_api_call",arguments:{operation_id:"getServerVersion",execution_mode:"sync"}});
      assert.equal((result.structuredContent ?? result.result).upstream.status,200);
      assert.ok(modernRequests.some(r=>r.body.method==="server/discover"));
      assert.ok(modernRequests.filter(r=>r.body.method==="tools/call").every(r=>r.headers["mcp-protocol-version"]==="2026-07-28"&&r.headers["mcp-method"]==="tools/call"));
    }finally{await client.close();}
    version={major:3,minor:4,patch:0,prerelease:null};await app.checkVersion();
    assert.equal((await request("/health/ready",undefined)).status,503);
    assert.equal(toolData(await call("immich_get_connection",{})).binding_state,"version_mismatch");
    assert.equal((await call("immich_api_call",{operation_id:"getServerVersion"})).result.isError,true);
    versionStatus=503;await app.checkVersion();assert.equal(app.health.state,"unreachable");
    assert.equal(toolData(await call("immich_api_call",{operation_id:"getServerVersion",execution_mode:"sync"})).upstream.status,503);
    const incompleteSeen=new Promise<void>(resolve=>http.server.once("request",()=>resolve()));
    const incomplete=nodeRequest(base+"/mcp",{method:"POST",agent:false,headers:{host:new URL(publicOrigin).host,
      "cf-access-jwt-assertion":tokenA,"content-type":"application/json","content-length":"100000",accept:"application/json, text/event-stream"}});
    const incompleteClosed=new Promise<void>(resolve=>{incomplete.on("error",()=>resolve());incomplete.on("close",()=>resolve());incomplete.on("response",res=>res.resume());});
    incomplete.write("{");await incompleteSeen;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(incomplete.destroyed,false);
    const closingAt=Date.now(),fallback=setTimeout(()=>incomplete.destroy(),5000);
    try{await http.close();assert.ok(Date.now()-closingAt<4500,"Shutdown waited for an incomplete request body");await incompleteClosed;}
    finally{clearTimeout(fallback);incomplete.destroy();}
  }finally{release();await http.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
