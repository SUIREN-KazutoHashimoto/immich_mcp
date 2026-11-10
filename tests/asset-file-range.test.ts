import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,rm } from "node:fs/promises";
import { createHash,randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { operation,describe,registry } from "../src/registry.js";
import { prepare } from "../src/serializer.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
import { uuid } from "./fixtures.js";

test("asset-file Range correction is explicit and leaves the pinned API definition, route and other inputs unchanged",async()=>{
  const api=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
  const op=operation("downloadAssetFile"),official=api.paths["/asset-files/{id}/download"].get;
  assert.deepEqual(op.definition,official);
  assert.equal(op.method,"GET");assert.equal(op.path,"/asset-files/{id}/download");
  assert.deepEqual(op.parameters,[...official.parameters,{in:"header",name:"Range",required:false,schema:{type:"string"}}]);
  assert.deepEqual(Object.keys(op.definition.responses),["200"]);
  const { $defs,...rangeSchema }=describe(op.operationId).input_schemas["header:Range"]!;
  assert.deepEqual(rangeSchema,{type:"string"});assert.deepEqual(Object.keys($defs),[]);
  const requirement=op.override!.requirements.find((r:any)=>r.requirement_id==="range_forwarding");
  assert.deepEqual(requirement.value.request_headers,["Range"]);
  assert.deepEqual(requirement.value.preserve_status_codes,[200,206,404,416]);
  assert.equal(op.override!.facts.find((f:any)=>f.fact_id==="asset_file_byte_range_support").value.runtime_verified,false);
  assert.ok(!operation("getAssetFile").parameters.some(p=>p.in==="header"&&p.name.toLowerCase()==="range"));
  assert.equal(registry.operations.length,279);
});

test("asset-file range input preserves header spelling semantics while retaining injection and unrelated-operation guards",async()=>{
  for(const spelling of ["Range","range","RANGE"]){
    const p=await prepare("http://immich.test/api",{operation_id:"downloadAssetFile",path:{id:uuid},headers:{[spelling]:"bytes=2-7"}});
    assert.equal(p.url.href,"http://immich.test/api/asset-files/"+uuid+"/download");
    assert.equal(p.method,"GET");assert.equal(p.headers.get("range"),"bytes=2-7");assert.equal(p.body,undefined);
  }
  for(const headers of [{Authorization:"Bearer forged"},{"x-api-key":"forged"},{Cookie:"forged"},{"Range":"bytes=0-1\r\nAuthorization: forged"},{"X-Unregistered":"x"}]){
    await assert.rejects(prepare("http://immich.test/api",{operation_id:"downloadAssetFile",path:{id:uuid},headers}));
  }
  await assert.rejects(prepare("http://immich.test/api",{operation_id:"getAssetFile",path:{id:uuid},headers:{Range:"bytes=0-1"}}),(e:any)=>e.code==="unknown_parameter");
  const old=await prepare("http://immich.test/api",{operation_id:"downloadAsset",path:{id:uuid},headers:{Range:"bytes=0-1"}});
  assert.equal(old.headers.get("range"),"bytes=0-1");
});

test("native HTTP retains asset-file full and partial bytes, range errors and caller isolation without credential fallback",async()=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-asset-file-range-"));
  const vault=new Vault(root,randomBytes(32),"test",":memory:"),idB="22222222-2222-4222-8222-222222222222";
  const bytesA=Buffer.from([0,255,1,128,2,254,3,127,4,253,5,126,6,252,7,125]),bytesB=Buffer.from(bytesA.map(b=>255-b));
  const errors:string[]=[],seen:{key:string;range:string|null;status:number}[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.method,"GET");assert.equal(req.url,"/api/asset-files/"+uuid+"/download");
      assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
      const key=String(req.headers["x-api-key"]);assert.ok(["key-A","key-B"].includes(key));
      const bytes=key==="key-A"?bytesA:bytesB,range=req.headers.range??null;
      let status=200,body=bytes,contentRange:string|undefined;
      if(range==="bytes=2-7"){status=206;body=bytes.subarray(2,8);contentRange="bytes 2-7/16";}
      else if(range==="bytes=12-"){status=206;body=bytes.subarray(12);contentRange="bytes 12-15/16";}
      else if(range==="bytes=-3"){status=206;body=bytes.subarray(13);contentRange="bytes 13-15/16";}
      else if(range==="bytes=99-"){status=404;body=Buffer.from("synthetic fixed-helper range refusal");contentRange="bytes */16";}
      else if(range==="bytes=100-"){status=416;body=Buffer.from("synthetic alternative range refusal");contentRange="bytes */16";}
      else assert.equal(range,null);
      seen.push({key,range,status});
      res.writeHead(status,{"content-type":status>=400?"text/plain":"image/jpeg","content-length":body.length,"accept-ranges":"bytes",...(contentRange?{"content-range":contentRange}:{}),"set-cookie":"unexpected=TRANSPORT-SECRET-CANARY; HttpOnly"});
      res.end(body);
    }catch(error){errors.push((error as Error).message);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const executor=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",vault);
  try{
    vault.replaceBinding("A","key-A",uuid,0);vault.replaceBinding("B","key-B",idB,0);
    for(const [range,status,expected,contentRange] of [
      [null,200,bytesA,undefined],
      ["bytes=2-7",206,bytesA.subarray(2,8),"bytes 2-7/16"],
      ["bytes=12-",206,bytesA.subarray(12),"bytes 12-15/16"],
      ["bytes=-3",206,bytesA.subarray(13),"bytes 13-15/16"],
      ["bytes=99-",404,Buffer.from("synthetic fixed-helper range refusal"),"bytes */16"],
      ["bytes=100-",416,Buffer.from("synthetic alternative range refusal"),"bytes */16"]
    ] as const){
      const reply=await executor.call("A",{operation_id:"downloadAssetFile",path:{id:uuid},...(range?{headers:{Range:range}}:{})});
      assert.equal(reply.state,"completed");assert.equal(reply.upstream?.status,status);
      assert.equal(reply.upstream?.headers?.["content-length"],String(expected.length));
      assert.equal(reply.upstream?.headers?.["accept-ranges"],"bytes");
      assert.equal(reply.upstream?.headers?.["content-range"],contentRange);
      assert.equal(reply.data,null);assert.equal(reply.diagnostic?.code,status>=400?"upstream_error":"artifact_result");
      assert.ok(!JSON.stringify(reply).includes("TRANSPORT-SECRET-CANARY"));
      const saved=vault.get("A",reply.result_ref!,"result"),raw=Buffer.from(await new Response(vault.rawStream("A",saved.raw.raw_ref) as any).arrayBuffer());
      assert.deepEqual(raw,expected);
      assert.equal(saved.raw.sha256,createHash("sha256").update(expected).digest("hex"));
      assert.throws(()=>vault.get("B",reply.result_ref!,"result"));
      assert.throws(()=>vault.rawStream("B",saved.raw.raw_ref));
    }
    const b=await executor.call("B",{operation_id:"downloadAssetFile",path:{id:uuid},headers:{range:"bytes=2-7"}});
    const savedB=vault.get("B",b.result_ref!,"result");
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("B",savedB.raw.raw_ref) as any).arrayBuffer()),bytesB.subarray(2,8));
    assert.throws(()=>vault.get("A",b.result_ref!,"result"));
    assert.equal(seen.length,7);assert.deepEqual(seen.slice(0,6).map(x=>x.status),[200,206,206,206,404,416]);
    assert.ok(seen.slice(0,6).every(x=>x.key==="key-A"));assert.equal(seen[6]!.key,"key-B");
    assert.deepEqual(errors,[]);
  }finally{
    await executor.close();vault.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    assert.ok(resolve(root).startsWith(parent+sep));await rm(root,{recursive:true,force:true});
  }
});
