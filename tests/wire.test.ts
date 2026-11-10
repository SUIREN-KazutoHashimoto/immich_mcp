import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { registry } from "../src/registry.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
import { prepare, type Resolver } from "../src/serializer.js";
import { fixture, sample, resolvedBody } from "./fixtures.js";

const fileBytes=Buffer.from([0,255,1,2,3,128,10,13]);
const resolver:Resolver={
  file:async()=>({filename:"photo.bin",mime:"application/octet-stream",size:fileBytes.length,
    open:()=> (async function*(){yield fileBytes;})()}),
  secret:async(_ref,_location,path)=>path.toLowerCase().includes("pincode")?"123456":"secret-fixture"
};
const collect=async(req:IncomingMessage)=>{const parts:Buffer[]=[];for await(const p of req)parts.push(p);return Buffer.concat(parts);};
test("all 279 operations reach real HTTP wire with exact route, method, auth and body",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"immich-wire-"));
  const vault=new Vault(directory,randomBytes(32),"test",":memory:");
  vault.replaceBinding("A","key-for-A","id-A",0);
  let reply:{status:number;mime:string;bytes:Buffer}|undefined;
  const passed:string[]=[];
  let received:{method:string;url:string;headers:any;bytes:Buffer}|undefined;
  const server=createServer(async(req,res)=>{
    received={method:req.method!,url:req.url!,headers:req.headers,bytes:await collect(req)};
    res.writeHead(reply?.status ?? 403,{"content-type":reply?.mime ?? "text/plain","retry-after":"7"});
    res.end(reply?.bytes ?? "upstream-error-secret-canary");
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const base="http://127.0.0.1:"+(server.address() as any).port+"/api";
  const executor=new Executor(base,vault);
  try {
    for (const op of registry.operations) await t.test(op.operationId,async()=>{
      received=undefined;reply=undefined;
      const call=fixture(op);
      const result=await executor.call("A",call,resolver);
      assert.ok(received,"executor must send a real request");
      const wire=received as {method:string;url:string;headers:any;bytes:Buffer};
      assert.equal(wire.method,op.method);
      const expectedPath=op.path.replace(/\{([^}]+)\}/g,(_,name)=>encodeURIComponent(String(call.path![name])));
      assert.equal(new URL(wire.url,base).pathname,"/api"+expectedPath);
      assert.equal(wire.headers["x-api-key"],"key-for-A");
      assert.equal(wire.headers.authorization,undefined);
      assert.equal(wire.headers.cookie,undefined);
      assert.equal(result.upstream?.status,403);
      assert.equal(result.upstream?.headers["retry-after"],"7");
      assert.equal(result.state,"completed");
      assert.ok(!JSON.stringify(result).includes("upstream-error-secret-canary"));
      if (call.content_type==="application/json") {
        assert.equal(wire.headers["content-type"],"application/json");
        assert.deepEqual(JSON.parse(wire.bytes.toString()),resolvedBody(call));
      } else if (call.content_type==="application/x-www-form-urlencoded") {
        assert.equal(wire.headers["content-type"],call.content_type);
        const form=new URLSearchParams(wire.bytes.toString());
        for(const [k,v] of Object.entries(resolvedBody(call)))assert.equal(form.get(k),String(v));
      } else if(call.content_type==="multipart/form-data") {
        const form=await new Response(new Uint8Array(wire.bytes),{headers:{"content-type":wire.headers["content-type"]}}).formData();
        for(const key of Object.keys(call.files!))assert.deepEqual(Buffer.from(await (form.get(key) as File).arrayBuffer()),fileBytes);
        for(const [k,v] of Object.entries(resolvedBody(call)))assert.equal(form.get(k),typeof v==="object"?JSON.stringify(v):String(v));
      } else assert.equal(wire.bytes.length,0);
      const stored=vault.get("A",result.result_ref!,"result");
      assert.equal(await new Response(vault.rawStream("A",stored.raw.raw_ref) as any).text(),"upstream-error-secret-canary");
      assert.throws(()=>vault.get("B",result.result_ref!,"result"));
      const [status,definition]=Object.entries<any>(op.definition.responses).find(([s])=>s.startsWith("2")) ?? ["200",{}];
      const [mime,media]=Object.entries<any>(definition.content ?? {})[0] ?? ["application/octet-stream",{}];
      const successBytes=media.schema?.format==="binary" ? fileBytes :
        mime==="application/json" ? Buffer.from(JSON.stringify(sample(media.schema))) :
        mime.includes("mpegurl") ? Buffer.from("#EXTM3U\nseg_0.m4s\n") : Buffer.alloc(0);
      reply={status:Number(status),mime,bytes:successBytes};
      const success=await executor.call("A",call,resolver);
      assert.equal(success.upstream?.status,Number(status));
      const successStored=vault.get("A",success.result_ref!,"result");
      const original=Buffer.from(await new Response(vault.rawStream("A",successStored.raw.raw_ref) as any).arrayBuffer());
      assert.deepEqual(original,successBytes);
      passed.push(op.operationId);
    });
    await mkdir(new URL("../reports/",import.meta.url),{recursive:true});
    await writeFile(new URL("../reports/operation-coverage.json",import.meta.url),JSON.stringify({
      scope:"core executor HTTP wire only; not final feature acceptance",
      version:registry.version,sha256:registry.sha256,
      missing:registry.operations.filter(o=>!passed.includes(o.operationId)).map(o=>o.operationId),unexpected:[],duplicate:[],
      operations:registry.operations.map(o=>({operation_id:o.operationId,method:o.method,path:o.path,
        core_wire_pass:passed.includes(o.operationId),integration_success:"not_run",upstream_refusal:"mock_403_only",
        environment:"isolated Immich and Cloudflare/ChatGPT not configured",feature_acceptance:"incomplete"}))
    },null,2)+"\n");
  } finally {server.close();server.closeAllConnections();vault.close();await rm(directory,{recursive:true,force:true});}
});
test("registration uses getMyApiKey only and preserves existing binding on failure",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"immich-register-"));
  const vault=new Vault(directory,randomBytes(32),"test",":memory:");
  const calls:string[]=[];
  let valid=true;
  const executor=new Executor("http://immich.test/api",vault,(async(url:any,init:any)=>{
    calls.push(String(url)); assert.equal(init.headers.get("x-api-key"),"candidate");
    return valid?Response.json(sample(registry.schemas.ApiKeyResponseDto!),{status:200}):new Response("",{status:403});
  }) as typeof fetch);
  try{
    assert.equal(await executor.register("A","candidate",0),1);
    valid=false;
    await assert.rejects(executor.register("A","candidate",1));
    assert.equal(vault.credential("A").key,"candidate");
    assert.ok(calls.every(u=>u==="http://immich.test/api/api-keys/me"));
  }finally{vault.close();await rm(directory,{recursive:true,force:true});}
});
