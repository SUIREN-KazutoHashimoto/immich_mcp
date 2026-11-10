import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { applyResponseCorrections } from "../scripts/response-corrections.js";
import { registry,operation,describe } from "../src/registry.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
import { sample,uuid } from "./fixtures.js";

const contract=JSON.parse(await readFile(new URL("../contracts/response-corrections.v3.3.5.json",import.meta.url),"utf8"));
const baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
function uncorrected(){
  const op=structuredClone(operation("createActivity"));delete op.definition.responses["200"];delete op.override;return [op];
}
test("a declared response correction copies only the source DTO and leaves the original operation and catalog triple unchanged",()=>{
  const input=uncorrected(),before=structuredClone(input),corrected=applyResponseCorrections(input,registry.schemas,registry.secretRules,contract,baseline);
  assert.deepEqual(input,before);assert.equal(corrected.length,1);
  const op=corrected[0]!;assert.equal(op.operationId,input[0]!.operationId);assert.equal(op.path,input[0]!.path);
  assert.deepEqual(op.definition.responses["200"].content["application/json"].schema,input[0]!.definition.responses["201"].content["application/json"].schema);
  assert.deepEqual(Object.keys(op.definition.responses).sort(),["200","201"]);
  assert.equal(describe("createActivity").overrides?.facts[0].fact_id,"duplicate_like_success_status");
  op.definition.responses["200"].content["application/json"].schema.$ref="mutated";assert.deepEqual(input,before);
});
test("stale fingerprints, mismatched DTOs, duplicate targets and non-JSON/error aliases fail before changing any operation",()=>{
  const changes=[
    (c:any)=>{c.openapi_sha256="wrong";},(c:any)=>{c.source_commit="wrong";},(c:any)=>{c.immich_version="latest";},
    (c:any)=>{c.corrections[0].api_relative_path="/wrong";},(c:any)=>{c.corrections[0].openapi_operation_pointer="#/paths/wrong/post";},
    (c:any)=>{c.corrections[0].schema_ref="#/components/schemas/UserResponseDto";},(c:any)=>{c.corrections[0].status_code=400;},
    (c:any)=>{c.corrections[0].schema_from_status_code=404;},(c:any)=>{c.corrections[0].content_type="text/plain";},
    (c:any)=>{c.corrections[0].source_urls=[];},(c:any)=>{delete c.corrections[0].fact_id;},(c:any)=>{c.corrections[0].fact_id=null;},(c:any)=>{c.corrections.push(structuredClone(c.corrections[0]));},(c:any)=>{c.corrections.push({...c.corrections[0],status_code:202});}
  ];
  for(const change of changes){const c=structuredClone(contract);change(c);const input=uncorrected(),before=structuredClone(input);assert.throws(()=>applyResponseCorrections(input,registry.schemas,registry.secretRules,c,baseline));assert.deepEqual(input,before);}
  assert.throws(()=>applyResponseCorrections([structuredClone(operation("createActivity"))],registry.schemas,registry.secretRules,contract,baseline));
});
test("a source-status secret binding needs exactly matching target-status protection before a schema can be reused",()=>{
  const source={operation_id:"createActivity",direction:"response",status_code:"201",instance_pointer_pattern:"/secret",container:"response"};
  const rules=[{bindings:[source]}];assert.throws(()=>applyResponseCorrections(uncorrected(),registry.schemas,rules,contract,baseline),/secret coverage/);
  assert.throws(()=>applyResponseCorrections(uncorrected(),registry.schemas,[{bindings:[source,{...source,status_code:"200",instance_pointer_pattern:"/different"}]}],contract,baseline),/secret coverage/);
  const corrected=applyResponseCorrections(uncorrected(),registry.schemas,[{bindings:[source,{...source,status_code:200}]}],contract,baseline);assert.ok(corrected[0]!.definition.responses["200"]);
});
test("native HTTP displays both new and duplicate likes while unknown statuses and fields remain withheld",async()=>{
  const tempRoot=resolve(tmpdir()),root=await mkdtemp(join(tempRoot,"immich-activity-response-")),v=new Vault(root,randomBytes(32),"test",":memory:");
  let count=0;const errors:string[]=[],body={...sample(registry.schemas.ActivityResponseDto!),id:uuid,type:"like",assetId:null,comment:null},canary="UNREVIEWED-RESPONSE-SECRET-CANARY";
  const server=createServer(async(req,res)=>{
    try{
      assert.ok(req.method==="POST"&&req.url==="/api/activities");assert.ok(req.headers["x-api-key"]==="key-A");
      assert.ok(!req.headers.authorization&&!req.headers.cookie);for await(const _ of req){/* drain */}count++;
      res.writeHead(count===1?201:count===3?202:200,{"content-type":"application/json"});
      res.end(JSON.stringify(count===4?{...body,unexpectedCredential:canary}:body));
    }catch(error){errors.push((error as Error).name);res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const e=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",v);
  try{
    v.replaceBinding("A","key-A",uuid,0);const call={operation_id:"createActivity",body:{albumId:uuid,type:"like"}};
    for(const status of [201,200]){const result=await e.call("A",call);assert.equal(result.state,"completed");assert.equal(result.upstream?.status,status);assert.deepEqual(result.data,body);}
    const unknown=await e.call("A",call);assert.equal(unknown.upstream?.status,202);assert.equal(unknown.data,null);assert.equal(unknown.diagnostic?.code,"artifact_result");
    const extra=await e.call("A",call);assert.equal(extra.upstream?.status,200);assert.ok(!JSON.stringify(extra).includes(canary));
    const saved=v.get("A",extra.result_ref!,"result"),raw=await new Response(v.rawStream("A",saved.raw.raw_ref) as any).text();
    assert.ok(raw.includes(canary));assert.throws(()=>v.get("B",extra.result_ref!,"result"));assert.equal(count,4);assert.deepEqual(errors,[]);
  }finally{await e.close();v.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));assert.ok(resolve(root).startsWith(tempRoot+sep));await rm(root,{recursive:true,force:true});}
});
