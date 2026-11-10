import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,rm,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,basename } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { applyTimelineStatusCorrection } from "../scripts/timeline-response-correction.js";
import { registry,operation,describe } from "../src/registry.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
import { sample } from "./fixtures.js";
const contract=JSON.parse(await readFile(new URL("../contracts/timeline-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
function uncorrected(){
  const op=structuredClone(operation("getTimeBucket"));
  op.definition.responses["200"].content["application/json"].schema={$ref:"#/components/schemas/TimeBucketAssetResponseDto"};delete op.override;return op;
}
test("timeline correction exposes only the exact source-verified enum column without changing shared components or caller inputs",()=>{
  const target=uncorrected(),other=structuredClone(operation("getTimeBuckets")),inputs=[target,other],before=structuredClone(inputs),schemas=structuredClone(registry.schemas),schemaBefore=structuredClone(schemas);
  const result=applyTimelineStatusCorrection(inputs,schemas,registry.secretRules,contract,baseline),corrected=result[0]!.definition.responses["200"].content["application/json"].schema;
  assert.deepEqual(inputs,before);assert.deepEqual(schemas,schemaBefore);assert.deepEqual(result[1],other);
  assert.deepEqual(result.map(o=>[o.operationId,o.method,o.path]),inputs.map(o=>[o.operationId,o.method,o.path]));
  assert.deepEqual(result[0]!.auth,target.auth);assert.deepEqual(result[0]!.parameters,target.parameters);
  const expected=structuredClone(schemas.TimeBucketAssetResponseDto!);expected.properties.status=contract.property_schema;
  assert.deepEqual(corrected,expected);assert.deepEqual(corrected.required,schemas.TimeBucketAssetResponseDto!.required);
  assert.ok(describe("getTimeBucket").overrides?.facts.some((f:any)=>f.fact_id===contract.fact_id&&f.value.runtime_verified===false));
  corrected.properties.status.items.enum.push("unreviewed");assert.deepEqual(inputs,before);assert.deepEqual(schemas,schemaBefore);
});
test("timeline schema pins reject stale components, arbitrary columns, relaxed enums, mismatched routes and duplicate targets atomically",()=>{
  const changes=[
    (c:any)=>{c.openapi_sha256="wrong";},(c:any)=>{c.source_commit="wrong";},(c:any)=>{c.immich_version="latest";},
    (c:any)=>{c.operation_id="getTimeBuckets";},(c:any)=>{c.http_method="POST";},(c:any)=>{c.api_relative_path="/wrong";},
    (c:any)=>{c.openapi_operation_pointer="#/paths/wrong";},(c:any)=>{c.status_code=201;},(c:any)=>{c.content_type="text/plain";},
    (c:any)=>{c.expected_schema={};},(c:any)=>{c.component_name="AssetResponseDto";},(c:any)=>{c.component_sha256="0".repeat(64);},
    (c:any)=>{c.property_name="arbitraryCredential";},(c:any)=>{c.property_schema.items.enum.push("unreviewed");},(c:any)=>{c.property_schema.items.nullable=true;},
    (c:any)=>{c.fact_id="arbitrary";},(c:any)=>{c.source_urls=[];},(c:any)=>{c.source_urls.push(c.source_urls[0]);},
    (c:any)=>{c.source_urls[0]="https://example.com/source";},(c:any)=>{c.arbitrary_schema={};}
  ];
  for(const change of changes){
    const c=structuredClone(contract),input=[uncorrected()],before=structuredClone(input),schemas=structuredClone(registry.schemas),schemaBefore=structuredClone(schemas);
    change(c);assert.throws(()=>applyTimelineStatusCorrection(input,schemas,registry.secretRules,c,baseline));assert.deepEqual(input,before);assert.deepEqual(schemas,schemaBefore);
  }
  for(const change of [(s:any)=>{s.TimeBucketAssetResponseDto.properties.ratio.items.type="string";},(s:any)=>{delete s.TimeBucketAssetResponseDto;},(s:any)=>{s.TimeBucketAssetResponseDto.properties.status=contract.property_schema;}]){
    const s=structuredClone(registry.schemas),input=[uncorrected()],before=structuredClone(input);change(s);
    assert.throws(()=>applyTimelineStatusCorrection(input,s,registry.secretRules,contract,baseline),/schema mismatch/);assert.deepEqual(input,before);
  }
  assert.throws(()=>applyTimelineStatusCorrection([uncorrected(),uncorrected()],registry.schemas,registry.secretRules,contract,baseline),/schema mismatch/);
});
test("timeline correction refuses secret-bearing responses and duplicate evidence facts",()=>{
  const b={operation_id:"getTimeBucket",direction:"response",status_code:200,instance_pointer_pattern:"/status/*"};
  for(const binding of [b,{...b,operation_id:"*"},{...b,status_code:201}]){
    const input=[uncorrected()],before=structuredClone(input);
    assert.throws(()=>applyTimelineStatusCorrection(input,registry.schemas,[{bindings:[binding]}],contract,baseline),/secret-bearing/);assert.deepEqual(input,before);
  }
  assert.ok(applyTimelineStatusCorrection([uncorrected()],registry.schemas,[{bindings:[{...b,direction:"request"}]}],contract,baseline)[0]);
  const input=uncorrected();input.override={facts:[{fact_id:contract.fact_id}]} as any;
  assert.throws(()=>applyTimelineStatusCorrection([input],registry.schemas,registry.secretRules,contract,baseline),/Duplicate timeline/);
});
test("native timeline replies preserve declared columns and known status values; unrelated fields, invalid enums and undeclared statuses stay protected",async()=>{
  const tempParent=await realpath(tmpdir()),root=await mkdtemp(join(tempParent,"immich-timeline-correction-"));assert.equal(dirname(await realpath(root)),tempParent);
  const v=new Vault(root,randomBytes(32),"test",":memory:"),canary="UNREVIEWED-TIMELINE-CREDENTIAL-CANARY";
  const dto=sample(registry.schemas.TimeBucketAssetResponseDto!),withStatus={...dto,status:["active","trashed","deleted"]};
  const scenarios=[
    {operation:"getTimeBucket",status:200,body:dto,diagnostic:null},
    {operation:"getTimeBucket",status:200,body:withStatus,diagnostic:null},
    {operation:"getTimeBucket",status:200,body:{...dto,status:[canary]},diagnostic:"response_schema_mismatch"},
    {operation:"getTimeBucket",status:200,body:{...dto,status:[7]},diagnostic:"response_schema_mismatch"},
    {operation:"getTimeBucket",status:200,body:{...dto,status:null},diagnostic:"response_schema_mismatch"},
    {operation:"getTimeBucket",status:200,body:{...withStatus,unreviewedCredential:canary},diagnostic:"projection_mismatch"},
    {operation:"getTimeBucket",status:201,body:withStatus,diagnostic:"artifact_result"},
    {operation:"getAssetInfo",status:200,body:{...sample(registry.schemas.AssetResponseDto!),status:["active"],unreviewedCredential:canary},diagnostic:"projection_mismatch"}
  ];
  let count=0;const errors:string[]=[];
  const server=createServer((req,res)=>{
    try{
      const expected=scenarios[count++]!,url=new URL(req.url!,"http://127.0.0.1");assert.equal(req.method,"GET");
      assert.equal(url.pathname,expected.operation==="getTimeBucket"?"/api/timeline/bucket":"/api/assets/11111111-1111-4111-8111-111111111111");
      assert.equal(req.headers["x-api-key"],"synthetic-key-A");assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
      res.writeHead(expected.status,{"content-type":"application/json"});res.end(JSON.stringify(expected.body));
    }catch(error){errors.push((error as Error).name);res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const e=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",v);
  try{
    v.replaceBinding("A","synthetic-key-A","synthetic-key-id",0);
    for(const expected of scenarios){
      const result=await e.call("A",{operation_id:expected.operation,...(expected.operation==="getTimeBucket"?{query:{timeBucket:"2023-07-01"}}:{path:{id:"11111111-1111-4111-8111-111111111111"}})});
      assert.equal(result.upstream?.status,expected.status);assert.equal(result.diagnostic?.code??null,expected.diagnostic);
      assert.equal(result.state,expected.diagnostic&&expected.diagnostic!=="artifact_result"?"failed":"completed");
      if(expected.diagnostic===null)assert.deepEqual(result.data,expected.body);else assert.equal(result.data,null);
      assert.equal(JSON.stringify(result).includes(canary),false);
      const saved=v.get("A",result.result_ref!,"result"),raw=await new Response(v.rawStream("A",saved.raw.raw_ref) as any).text();
      assert.equal(raw,JSON.stringify(expected.body));assert.throws(()=>v.get("B",result.result_ref!,"result"));
    }
    assert.equal(count,scenarios.length);assert.deepEqual(errors,[]);
  }finally{
    await e.close();v.close();server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));
    const physical=await realpath(root);assert.equal(dirname(physical),tempParent);assert.ok(basename(physical).startsWith("immich-timeline-correction-"));await rm(physical,{recursive:true,force:true});
  }
});
