import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Upstream } from "../src/upstream.js";
test("nonpersistent provisioning requests remain independent across an idle interval without retry",async t=>{
  const connections=new Set<unknown>(),headers:(string|undefined)[]=[],paths:string[]=[];
  const server=createServer((req,res)=>{connections.add(req.socket);headers.push(req.headers.connection);paths.push(req.url!);res.end("ok");});
  server.keepAliveTimeout=5000;server.listen(0,"127.0.0.1");await once(server,"listening");
  const base="http://127.0.0.1:"+(server.address() as any).port+"/api",http=new Upstream(base,{concurrency:1,reuseConnections:false});
  let error:unknown;
  try{
    assert.equal(await (await http.fetch(base+"/probe",{redirect:"manual"})).text(),"ok");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6500);
    try{assert.equal(await (await http.fetch(base+"/next",{redirect:"manual"})).text(),"ok");}catch(value){error=value;}
    t.diagnostic(JSON.stringify({requests:paths.length,connections:connections.size,connection_headers:headers,error_code:(error as any)?.code}));
    assert.equal(error,undefined);assert.deepEqual(paths,["/api/probe","/api/next"]);assert.deepEqual(headers,["close","close"]);assert.equal(connections.size,2);
  }finally{await http.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("ordinary upstream traffic retains connection reuse and invalid reuse options are rejected",async()=>{
  const connections=new Set<unknown>(),headers:(string|undefined)[]=[];
  const server=createServer((req,res)=>{connections.add(req.socket);headers.push(req.headers.connection);res.end("ok");});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base="http://127.0.0.1:"+(server.address() as any).port+"/api",http=new Upstream(base,{concurrency:1});
  try{
    assert.throws(()=>new Upstream(base,{reuseConnections:0 as any}),/Invalid upstream connection reuse/);
    for(let i=0;i<2;i++)assert.equal(await (await http.fetch(base+"/normal",{redirect:"manual"})).text(),"ok");
    assert.equal(connections.size,1);assert.deepEqual(headers,["keep-alive","keep-alive"]);
  }finally{await http.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
