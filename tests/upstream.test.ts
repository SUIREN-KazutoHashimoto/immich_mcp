import test from "node:test";
import assert from "node:assert/strict";
import { createServer,type RequestListener,type ServerResponse } from "node:http";
import { createServer as tcpServer,type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { Upstream,UpstreamError,sendUpstream,releaseUpstream,transportError,type UpstreamOptions } from "../src/upstream.js";
import { BridgeError } from "../src/types.js";

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(handler:RequestListener,run:(client:Upstream,base:string)=>Promise<void>,options:UpstreamOptions={}){
  const server=createServer(handler),sockets=new Set<Socket>();
  server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+(server.address() as any).port+"/api",client=new Upstream(base,options);
  try{await run(client,base);}finally{await client.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test("transport preserves compressed wire bytes, repeated cookies and manual redirects",async()=>{
  const raw=gzipSync(Buffer.from('{"ok":true}'));let requests=0;
  await fixture((req,res)=>{
    requests++;assert.equal(req.headers["x-api-key"],"LOCAL-CANARY");assert.equal(req.headers["accept-encoding"],"identity");
    if(req.url==="/api/redirect"){res.writeHead(307,{location:"https://elsewhere.invalid/private?token=CANARY","set-cookie":["a=one; HttpOnly","b=two; HttpOnly"]});res.end();return;}
    res.writeHead(200,{"content-type":"application/json","content-encoding":"gzip","content-length":raw.length});res.end(raw);
  },async(client,base)=>{
    const response=await client.fetch(base+"/compressed",{headers:{"x-api-key":"LOCAL-CANARY"},redirect:"manual"});
    assert.equal(response.headers.get("content-encoding"),"gzip");assert.equal(Number(response.headers.get("content-length")),raw.length);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),raw);
    const redirect=await client.fetch(base+"/redirect",{headers:{"x-api-key":"LOCAL-CANARY"},redirect:"manual"});
    assert.equal(redirect.status,307);assert.equal(redirect.headers.getSetCookie().length,2);await redirect.body?.cancel();
    assert.equal(requests,2);
    await assert.rejects(client.fetch("https://other.invalid/api/x"),{code:"upstream_target"});
    await assert.rejects(client.fetch(base+"/x",{redirect:"follow"}),{code:"upstream_redirect"});
    assert.equal(requests,2);
  });
});
test("FIFO capacity remains held through body consumption and runs checks only at actual dispatch",async()=>{
  const seen:string[]=[],checked:string[]=[];let held:ServerResponse|undefined,version=1;
  await fixture((req,res)=>{seen.push(req.url!);if(req.url==="/api/first"){held=res;res.write("first");}else res.end(req.url);},async(client,base)=>{
    const first=await sendUpstream(client.fetch,base+"/first",{redirect:"manual"},()=>checked.push("first"));
    const second=sendUpstream(client.fetch,base+"/second",{redirect:"manual"},()=>checked.push("second-v"+version));
    const third=sendUpstream(client.fetch,base+"/third",{redirect:"manual"},()=>checked.push("third"));
    await pause(30);assert.deepEqual(seen,["/api/first"]);assert.deepEqual(checked,["first"]);
    version=2;held!.end();assert.equal(await first.text(),"first");
    assert.equal(await (await second).text(),"/api/second");assert.equal(await (await third).text(),"/api/third");
    assert.deepEqual(seen,["/api/first","/api/second","/api/third"]);assert.deepEqual(checked,["first","second-v2","third"]);
  },{concurrency:1});
});
test("cancelling a queued request or a failed before-send check never invokes its HTTP operation",async()=>{
  const seen:string[]=[];let held:ServerResponse|undefined,checked=0;
  await fixture((req,res)=>{seen.push(req.url!);if(req.url==="/api/first"){held=res;res.write("first");}else res.end("last");},async(client,base)=>{
    const first=await client.fetch(base+"/first");
    const controller=new AbortController();
    const cancelled=assert.rejects(sendUpstream(client.fetch,base+"/cancelled",{signal:controller.signal,redirect:"manual"},()=>checked++),{code:"upstream_cancelled"});
    const stale=assert.rejects(sendUpstream(client.fetch,base+"/stale",{redirect:"manual"},()=>{checked++;throw new BridgeError("credential_changed","Synthetic stale binding");}),{code:"credential_changed"});
    const last=client.fetch(base+"/last");
    controller.abort();await cancelled;assert.equal(checked,0);held!.end();await first.text();await stale;
    assert.equal(await (await last).text(),"last");assert.equal(checked,1);assert.deepEqual(seen,["/api/first","/api/last"]);
  },{concurrency:1});
});
test("bounded waiting capacity rejects overload before sending and cancellation releases the slot",async()=>{
  let requests=0;
  await fixture((_req,res)=>{requests++;res.write("data");},async(client,base)=>{
    const first=await client.fetch(base+"/first"),controller=new AbortController();
    const queued=assert.rejects(client.fetch(base+"/queued",{signal:controller.signal}),{code:"upstream_cancelled"});
    await assert.rejects(client.fetch(base+"/overflow"),{code:"upstream_busy"});assert.equal(requests,1);
    controller.abort();await queued;await first.body!.cancel();
  },{concurrency:1,maxQueued:1});
});
test("header and body idle timeouts remain distinct from connection failure and never retry",async()=>{
  let requests=0;
  await fixture((req,res)=>{requests++;if(req.url==="/api/body"){res.writeHead(200,{"content-type":"text/plain"});res.write("prefix");}},async(client,base)=>{
    await assert.rejects(client.fetch(base+"/headers"),error=>error instanceof UpstreamError&&error.code==="upstream_idle_timeout"&&error.phase==="headers"&&error.mayHaveBeenSent);
    const body=await client.fetch(base+"/body"),reader=body.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(),"prefix");
    await assert.rejects(reader.read(),error=>error instanceof UpstreamError&&error.code==="upstream_idle_timeout"&&error.phase==="body"&&error.mayHaveBeenSent);
    reader.releaseLock();assert.equal(requests,2);
  },{idleTimeoutMs:80});
});
test("TLS handshake timeout is a connection-stage failure before HTTP transmission",async()=>{
  const server=tcpServer(),sockets=new Set<Socket>();let connections=0;
  server.on("connection",socket=>{connections++;sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="https://127.0.0.1:"+(server.address() as any).port+"/api",client=new Upstream(base,{connectTimeoutMs:80,idleTimeoutMs:1000});
  try{
    await assert.rejects(client.fetch(base+"/x"),error=>error instanceof UpstreamError&&error.code==="upstream_connect_timeout"&&error.phase==="connect"&&!error.mayHaveBeenSent);
    assert.equal(connections,1);
  }finally{await client.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test("streaming multipart bytes reach HTTP without buffering and premature bodies fail without retry",async()=>{
  let requests=0;
  const parts=[Buffer.from("--b\r\n"),Buffer.from([0,255,128]),Buffer.from("\r\n--b--")];
  await fixture(async(req,res)=>{
    requests++;
    if(req.url==="/api/broken"){res.writeHead(200,{"content-length":"20"});res.write("prefix");setTimeout(()=>res.destroy(),20);return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),Buffer.concat(parts));res.end("stored");
  },async(client,base)=>{
    const body=(async function*(){for(const part of parts)yield part;})();
    const response=await client.fetch(base+"/upload",{method:"POST",headers:{"content-type":"multipart/form-data; boundary=b"},body:body as any,redirect:"manual"});
    assert.equal(await response.text(),"stored");
    const broken=await client.fetch(base+"/broken");
    await assert.rejects(broken.arrayBuffer(),error=>error instanceof UpstreamError&&error.mayHaveBeenSent);
    assert.equal(requests,2);
  });
});
test("shutdown cancels queued and active transfers without opening queued requests",async()=>{
  let requests=0;
  await fixture((_req,res)=>{requests++;res.write("first");},async(client,base)=>{
    const first=await client.fetch(base+"/active"),reader=first.body!.getReader();await reader.read();
    const pending=reader.read(),observed=assert.rejects(pending);
    const queued=assert.rejects(client.fetch(base+"/queued"),{code:"upstream_cancelled"});
    await client.close();await queued;await observed;reader.releaseLock();assert.equal(requests,1);
  },{concurrency:1});
});

test("executor-retained capacity survives body EOF until projection explicitly releases it",async()=>{
  const seen:string[]=[];
  await fixture((req,res)=>{seen.push(req.url!);res.end("body");},async(client,base)=>{
    const first=await sendUpstream(client.fetch,base+"/first",{redirect:"manual"},()=>{},true);
    assert.equal(await first.text(),"body");
    const next=client.fetch(base+"/next");await pause(30);assert.deepEqual(seen,["/api/first"]);
    releaseUpstream(first);releaseUpstream(first);
    assert.equal(await (await next).text(),"body");assert.deepEqual(seen,["/api/first","/api/next"]);
  },{concurrency:1});
});

test("TLS errors after a possible send never claim the request was unsent without connection evidence",()=>{
  for(const phase of ["request","body"] as const)for(const code of ["ERR_SSL_BAD_RECORD_MAC","ERR_TLS_ALERT_INTERNAL_ERROR","ECONNRESET"]){
    const failure=transportError(Object.assign(Error("PRIVATE-TRANSPORT-CANARY"),{code}),phase);
    assert.equal(failure.mayHaveBeenSent,true);assert.equal(failure.phase,phase);
    assert.ok(!failure.message.includes("PRIVATE-TRANSPORT-CANARY"));
  }
  const initial=transportError(Object.assign(Error("private certificate details"),{code:"ERR_TLS_CERT_ALTNAME_INVALID"}),"request",true);
  assert.equal(initial.phase,"connect");assert.equal(initial.mayHaveBeenSent,false);
  assert.equal(transportError(initial,"body").mayHaveBeenSent,true);
});
