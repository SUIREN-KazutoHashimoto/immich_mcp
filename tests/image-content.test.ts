import { imageMetadata } from "../src/image-response.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as nodeRequest } from "node:http";
import { Readable } from "node:stream";
import { serve } from "../src/http.js";
import { exportJWK,generateKeyPair,createLocalJWKSet,SignJWT } from "jose";
import sharp from "sharp";
import { Client,StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Application } from "../src/app.js";
import { waitForTestJob } from "./job-wait.js";
import { uuid } from "./fixtures.js";
import { IMAGE_VIEWER_URI,LEGACY_IMAGE_VIEWER_URI,IMAGE_VIEWER_MIME } from "../src/image-viewer.js";

test("image artifacts reach legacy MCP and the official modern client as ImageContent",{timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-image-wire-"));
  const image=await sharp({create:{width:120,height:60,channels:3,background:"#cc2200"}}).jpeg()
    .withExif({IFD0:{Artist:"PRIVATE-EXIF-CANARY"}}).toBuffer();
  const issuer="https://team.cloudflareaccess.com",publicOrigin="https://mcp.example.test";
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="test-image";
  const token=await new SignJWT({iss:issuer,aud:"test",sub:"image-user",exp:Math.floor(Date.now()/1000)+60})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
  const other=await new SignJWT({iss:issuer,aud:"test",sub:"other-user",exp:Math.floor(Date.now()/1000)+60})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
  let viewHits=0;
  const app=await Application.create({upstream:"http://immich/api",publicOrigin,issuer,audience:"test",jwksUrl:issuer+"/cdn-cgi/access/certs",
    directory:dir,masterKey:randomBytes(32),host:"127.0.0.1",port:0},{databasePath:":memory:",versionIntervalMs:0,
    cleanupIntervalMs:0,localIntervalMs:0,jwks:createLocalJWKSet({keys:[jwk]}),http:async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname==="/api/server/version")return Response.json({major:3,minor:3,patch:5,prerelease:null});
      assert.equal(url.pathname,"/api/assets/"+uuid+"/thumbnail");assert.equal(new Headers(init?.headers).get("x-api-key"),"IMAGE-KEY-CANARY");
      assert.equal(new Headers(init?.headers).get("cf-access-jwt-assertion"),null);viewHits++;
      return new Response(new Uint8Array(image),{headers:{"content-type":"image/jpeg","content-length":String(image.length)}});
    }});
  const http=await serve(app),base="http://127.0.0.1:"+(http.address as any).port;
  const localFetch=async(request:Request)=>{
    const url=new URL(request.url),body=request.body?Buffer.from(await request.arrayBuffer()):undefined;
    return new Promise<Response>((resolve,reject)=>{
      const outgoing=nodeRequest(base+url.pathname+url.search,{method:request.method,agent:false,signal:request.signal,
        headers:{...Object.fromEntries(request.headers),host:url.host}},response=>{
        const headers=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)headers.append(response.rawHeaders[i]!,response.rawHeaders[i+1]!);
        resolve(new Response([204,304].includes(response.statusCode!)?null:Readable.toWeb(response) as ReadableStream<Uint8Array>,{status:response.statusCode,headers}));
      });
      outgoing.on("error",reject);outgoing.setTimeout(10000,()=>outgoing.destroy(new Error("Local MCP request timed out")));outgoing.end(body);
    });
  };
  let client:Client|undefined;
  try{
    const principal=await app.access.authenticate(token);app.vault.replaceBinding(principal,"IMAGE-KEY-CANARY",uuid,0);
    let id=0;
    const rpc=async(method:string,params:any,assertion=token)=>{
      const response=await localFetch(new Request(publicOrigin+"/mcp",{method:"POST",headers:{
        "cf-access-jwt-assertion":assertion,"content-type":"application/json",accept:"application/json, text/event-stream",
        "mcp-protocol-version":"2025-11-25"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})}));
      assert.equal(response.status,200);const text=await response.text();
      return text.trim().startsWith("{")?JSON.parse(text):JSON.parse(text.split("\n").filter(l=>l.startsWith("data:")).at(-1)!.slice(5));
    };
    const call=(name:string,args:any,assertion=token)=>rpc("tools/call",{name,arguments:args},assertion);
    const data=(r:any)=>{assert.equal(r.error,undefined);assert.equal(r.result.isError,undefined,JSON.stringify(r.result.content));return r.result.structuredContent;};
    await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"image-regression",version:"1"}});
    const ack=data(await call("immich_api_call",{operation_id:"viewAsset",path:{id:uuid},query:{size:"preview"},result_mode:"auto"}));
    assert.equal(ack.state,"queued");
    const done=await waitForTestJob(async()=>data(await call("immich_get_job",{job_ref:ack.job_ref})));
    assert.equal(done.state,"completed");assert.equal(done.result.upstream.status,200);assert.equal(done.result.data,null);
    const ref=done.result.result_ref;
    const preview=data(await call("immich_read_result",{result_ref:ref,mode:"preview"}));
    assert.equal(preview.complete,true);assert.equal(preview.data.diagnostic.code,"artifact_result");
    const reply=await call("immich_read_image",{result_ref:ref,max_width:80,max_height:80});
    assert.equal(reply.error,undefined,JSON.stringify(reply));
    assert.equal(reply.result?.isError,undefined,JSON.stringify(reply));
    assert.equal(reply.result.structuredContent,undefined);
    const content=reply.result.content.find((c:any)=>c.type==="image");
    assert.ok(content,"MCP must contain a top-level image, not a JSON representation of one");
    assert.equal(content.mimeType,"image/jpeg");
    assert.deepEqual(reply.result._meta.image_content,content,"Viewer fallback must use exactly the authorized preview pixels");
    const bytes=Buffer.from(content.data,"base64"),meta=await sharp(bytes).metadata();
    assert.equal(meta.width,80);assert.equal(meta.height,40);assert.equal(meta.exif,undefined);
    assert.equal(imageMetadata(reply.result).display_status,"unconfirmed","Server success cannot claim client display success");
    assert.equal(imageMetadata(reply.result).size_bytes,bytes.length);assert.equal(imageMetadata(reply.result).result_ref,ref);
    assert.ok(!JSON.stringify(imageMetadata(reply.result)).includes(content.data));
    const forbidden=await call("immich_read_image",{result_ref:ref},other);
    assert.equal(forbidden.result.isError,true);assert.ok(forbidden.result.content.every((c:any)=>c.type==="text"));
    assert.equal((await localFetch(new Request(publicOrigin+"/mcp",{method:"POST",body:"{}"}))).status,401);
    const tools=(await rpc("tools/list",{})).result.tools;
    assert.equal(tools.find((t:any)=>t.name==="immich_get_image")?.outputSchema,undefined);
    assert.ok(tools.find((t:any)=>t.name==="immich_get_server_info")?.outputSchema,"Generic JSON tools retain their schema");
    const descriptor=tools.find((t:any)=>t.name==="immich_read_image");assert.ok(descriptor);assert.equal(descriptor.outputSchema,undefined);
    assert.equal(descriptor.annotations.readOnlyHint,true);assert.equal(descriptor.annotations.destructiveHint,false);
    assert.equal(descriptor._meta.ui.resourceUri,IMAGE_VIEWER_URI);
    const resources=(await rpc("resources/list",{})).result.resources;assert.ok(resources.some((r:any)=>r.uri===IMAGE_VIEWER_URI));
    const resource=(await rpc("resources/read",{uri:IMAGE_VIEWER_URI})).result.contents[0];
    const legacyResource=(await rpc("resources/read",{uri:LEGACY_IMAGE_VIEWER_URI})).result.contents[0];
    assert.equal(legacyResource.uri,LEGACY_IMAGE_VIEWER_URI);assert.equal(legacyResource.text,resource.text);
    assert.equal(resource.mimeType,IMAGE_VIEWER_MIME);assert.ok(resource.text.includes("ui/notifications/tool-result"));
    assert.ok(!resource.text.includes(content.data));assert.ok(!resource.text.includes("IMAGE-KEY-CANARY"));
    client=new Client({name:"image-modern-sdk",version:"1"},{versionNegotiation:{mode:{pin:"2026-07-28"}}});
    const wire:any[]=[];
    const transportFetch:typeof fetch=async(input,init)=>{
      const request=new Request(input,init),headers=new Headers(request.headers);headers.set("cf-access-jwt-assertion",token);
      const response=await localFetch(new Request(request,{headers}));const clone=response.clone();
      const text=await clone.text();if(text)wire.push(text);
      return response;
    };
    await client.connect(new StreamableHTTPClientTransport(new URL(publicOrigin+"/mcp"),{fetch:transportFetch}));
    const modern:any=await client.callTool({name:"immich_read_image",arguments:{result_ref:ref,format:"webp"}});
    assert.equal(modern.isError,undefined);const modernImage=modern.content.find((c:any)=>c.type==="image");assert.ok(modernImage);
    assert.equal(modernImage.mimeType,"image/webp");assert.equal((await sharp(Buffer.from(modernImage.data,"base64")).metadata()).format,"webp");
    assert.ok(wire.some(t=>t.includes('"type":"image"')));
    assert.equal(viewHits,1,"Reading an image artifact must not repeat the upstream request");
    const fast:any=await client.callTool({name:"immich_get_image",arguments:{source:"asset",asset_id:uuid,max_width:80,max_height:80}});
    assert.equal(fast.isError,undefined);assert.equal(fast.structuredContent,undefined);assert.equal(imageMetadata(fast).asset_id,uuid);
    assert.deepEqual(fast.content.find((c:any)=>c.type==="image"),content,"The one-call image must survive the MCP transport with identical pixels");
    assert.equal(viewHits,2);
    assert.ok(!wire.join("").includes("IMAGE-KEY-CANARY"));assert.ok(!wire.join("").includes("PRIVATE-EXIF-CANARY"));
    const original=app.vault.get(principal,ref,"result");const chunks:Buffer[]=[];
    for await(const chunk of app.vault.rawStream(principal,original.raw.raw_ref))chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks),image,"The encrypted original must remain unchanged");
  }finally{await client?.close();await http.close();await rm(dir,{recursive:true,force:true});}
});
