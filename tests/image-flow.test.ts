import { imageMetadata } from "../src/image-response.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { Application } from "../src/app.js";
import { ToolService } from "../src/tools.js";
import { operation,registry,referencedSchemas } from "../src/registry.js";
import { imageToolNames,requireImageContent } from "../src/image-response.js";
import { inspectImageResult } from "../scripts/image-result-check.js";
import { sample,uuid } from "./fixtures.js";

async function fixture(run:(app:Application,h:{calls:string[];bodies:any[];set:(f:(url:URL,init?:RequestInit)=>Promise<Response>)=>void})=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-image-flow-"));
  const photo=await sharp({create:{width:1200,height:900,channels:3,background:"#2468bc"}}).jpeg().withExif({IFD0:{Artist:"PRIVATE-CANARY"}}).toBuffer();
  const asset={...sample(operation("searchRandom").definition.responses["200"].content["application/json"].schema)[0],id:uuid,type:"IMAGE"};
  const calls:string[]=[],bodies:any[]=[];
  let handler=async(url:URL,_init?:RequestInit)=>url.pathname==="/api/search/random"?Response.json([asset]):new Response(new Uint8Array(photo),{headers:{"content-type":"image/jpeg"}});
  const app=await Application.create({upstream:"http://immich/api",publicOrigin:"https://mcp.example.test",issuer:"https://team.cloudflareaccess.com",audience:"test",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    directory:dir,masterKey:randomBytes(32),host:"127.0.0.1",port:0},{databasePath:":memory:",versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0,http:async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname==="/api/server/version")return Response.json({major:3,minor:3,patch:5,prerelease:null});
      assert.equal(new Headers(init?.headers).get("x-api-key"),"FLOW-KEY");calls.push(url.pathname);if(init?.body)bodies.push(JSON.parse(String(init.body)));
      return handler(url,init);
    }});
  app.vault.replaceBinding("A","FLOW-KEY",uuid,0);
  try{await run(app,{calls,bodies,set:f=>{handler=f;}});}finally{await app.close();await rm(dir,{recursive:true,force:true});}
}
test("one asset call returns native pixels with identical quality and no job polling",()=>fixture(async(app,h)=>{
  for(const format of ["jpeg","webp"]as const)for(const size of [700,1600,2048]){
    const result=await app.tools.invoke("A","immich_get_image",{source:"asset",asset_id:uuid,max_width:size,max_height:size,format});
    assert.equal(requireImageContent(result),result);assert.equal(imageMetadata(result).asset_id,uuid);assert.equal(imageMetadata(result).display_status,"unconfirmed");
    const old=await app.tools.invoke("A","immich_read_image",{result_ref:imageMetadata(result).result_ref,max_width:size,max_height:size,format});
    assert.deepEqual(result.content[0],old.content[0]);assert.equal(result._meta.image_content,result.content[0]);
    assert.equal((await sharp(Buffer.from(result.content[0].data,"base64")).metadata()).exif,undefined);
  }
  assert.equal(h.calls.length,6);assert.equal(app.vault.db.prepare("SELECT COUNT(*) n FROM jobs").get()!.n,0);
}));
test("random selection performs exactly one bounded search and one preview fetch",()=>fixture(async(app,h)=>{
  const result=await app.tools.invoke("A","immich_get_image",{source:"random"});
  assert.equal(result.content[0].type,"image");assert.equal(h.calls.length,2);
  assert.deepEqual(h.bodies,[{size:1,filter:{type:{eq:"IMAGE"}},withExif:false,withPeople:false}]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE-CANARY"));assert.ok(!JSON.stringify(result).includes("FLOW-KEY"));
}));
test("invalid fast inputs are rejected before any upstream request",()=>fixture(async(app,h)=>{
  for(const input of [{},{source:"asset"},{source:"asset",asset_id:"bad"},{source:"random",asset_id:uuid},{source:"random",max_width:0},{source:"random",format:"png"},{source:"random",url:"https://external.invalid"}])
    await assert.rejects(app.tools.invoke("A","immich_get_image",input),{code:"invalid_image_options"});
  assert.equal(h.calls.length,0);
}));
test("empty search, upstream refusal and corrupt pixels never become image success",()=>fixture(async(app,h)=>{
  h.set(async()=>Response.json([]));await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"random"}),{code:"image_not_found"});
  h.set(async()=>new Response("refused",{status:403}));await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"asset",asset_id:uuid}),{code:"image_upstream_failed"});
  h.set(async()=>new Response("broken",{headers:{"content-type":"image/jpeg"}}));await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"asset",asset_id:uuid}),{code:"image_decode_failed"});
  assert.equal(h.calls.length,3);
}));
test("credential change after random search fences the image fetch",()=>fixture(async(app,h)=>{
  h.set(async()=>{app.vault.replaceBinding("A","new-key",uuid,1);return Response.json([]);});
  await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"random"}),{code:"credential_conflict"});assert.equal(h.calls.length,1);
}));
test("cancellation aborts a pending fetch without background jobs or retries",()=>fixture(async(app,h)=>{
  h.set(async(_url,init)=>new Promise((_accept,reject)=>{init!.signal!.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});}));
  await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"asset",asset_id:uuid},AbortSignal.timeout(20)),{code:"image_cancelled"});
  assert.ok(h.calls.length<=1);assert.equal(app.vault.db.prepare("SELECT COUNT(*) n FROM jobs").get()!.n,0);
}));
test("the whole fast-image request has a thirty-second deadline",{timeout:40000},()=>fixture(async(app,h)=>{
  h.set(async(_url,init)=>new Promise((_accept,reject)=>{
    const keepAlive=setTimeout(()=>reject(new Error("deadline did not abort upstream")),35000);
    init!.signal!.addEventListener("abort",()=>{clearTimeout(keepAlive);reject(new Error("aborted"));},{once:true});
  }));
  const start=performance.now();await assert.rejects(app.tools.invoke("A","immich_get_image",{source:"asset",asset_id:uuid}),{code:"image_fetch_timeout"});
  assert.ok(performance.now()-start>=29000);assert.equal(h.calls.length,1);
}));
test("an internal response cap stops capture without changing the global executor limit",()=>fixture(async(app,h)=>{
  h.set(async()=>new Response(new Uint8Array(4096),{headers:{"content-type":"image/jpeg"}}));
  const capped=await app.executor.call("A",{operation_id:"viewAsset",path:{id:uuid},query:{size:"preview"}},undefined,{maxResponseBytes:1024});
  assert.notEqual(capped.state,"completed");assert.equal(capped.diagnostic?.code,"result_limit");
  const saved=app.vault.get("A",capped.result_ref!,"result");assert.equal(saved.raw.size,1024);assert.equal(saved.raw.interrupted,true);
  const full=await app.executor.call("A",{operation_id:"viewAsset",path:{id:uuid},query:{size:"preview"}});
  assert.equal(full.state,"completed");assert.equal(app.vault.get("A",full.result_ref!,"result").raw.size,4096);
}));
test("fast images still require the current user's registered key",()=>fixture(async(app,h)=>{
  await assert.rejects(app.tools.invoke("B","immich_get_image",{source:"asset",asset_id:uuid}),{code:"key_required"});assert.equal(h.calls.length,0);
}));
test("schema descriptions contain complete reachable definitions and no unrelated definitions",()=>fixture(async(app)=>{
  for(const id of ["viewAsset","searchRandom","searchAssets"]){
    const d=await app.tools.invoke("A","immich_api_describe",{operation_ids:[id]});
    assert.equal(d.truncated,false);assert.equal(d.result_ref,null);assert.ok(Buffer.byteLength(JSON.stringify(d))<128*1024);
    const defs=referencedSchemas([operation(id).definition]);assert.deepEqual(d.definitions,defs);
    assert.ok(Object.keys(d.definitions).length<Object.keys(registry.schemas).length);
  }
  const recursive={A:{properties:{b:{$ref:"#/components/schemas/B"}}},B:{anyOf:[{$ref:"#/components/schemas/A"}]},Unused:{type:"string"}};
  assert.deepEqual(Object.keys(referencedSchemas([{$ref:"#/components/schemas/A"}],recursive)).sort(),["A","B"]);
  const constrained=new ToolService(app.vault,app.executor,app.contexts,app.control,app.staging,app.jobs,app.config.publicOrigin,()=>app.health,{inlineBytes:64});
  const large=await constrained.invoke("A","immich_api_describe",{operation_ids:["viewAsset"]});
  assert.equal(large.truncated,true);assert.ok(large.result_ref);
  assert.equal(constrained.views.read("A",{result_ref:large.result_ref,json_pointer:"/operations/0/operation_id"}).data,"viewAsset");
}));
test("full result wrappers preserve images; flattened metadata is explicitly not visual input",async()=>{
  assert.deepEqual([...imageToolNames],["immich_read_image","immich_get_image"]);
  const image={type:"image",mimeType:"image/jpeg",data:(await sharp({create:{width:16,height:8,channels:3,background:"red"}}).jpeg().toBuffer()).toString("base64")};
  const result={content:[image],structuredContent:{content_type:"image",display_status:"unconfirmed"}};
  for(const wrapped of [result,{jsonrpc:"2.0",result},{mcp_tool_result:result},{call_tool_result:result}])assert.equal(requireImageContent(wrapped),result);
  assert.throws(()=>requireImageContent(result.structuredContent),{code:"image_content_missing"});
  const missing=await inspectImageResult({...result.structuredContent,display_status:"displayed"});
  assert.equal(missing.ok,false);assert.equal(missing.code,"image_content_missing");assert.equal(missing.model_input_delivery,"unknown");
});
