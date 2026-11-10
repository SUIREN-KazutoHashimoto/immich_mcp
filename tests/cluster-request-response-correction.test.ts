import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,rm,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,basename } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { applyResponseCorrections } from "../scripts/response-corrections.js";
import { registry,operation,describe } from "../src/registry.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
import type { ApiCall } from "../src/types.js";
const contract=JSON.parse(await readFile(new URL("../contracts/cluster-request-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const activity=JSON.parse(await readFile(new URL("../contracts/response-corrections.v3.3.5.json",import.meta.url),"utf8"));
const baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
function uncorrected(){
  const op=structuredClone(operation("createClusterGroupRequest"));delete op.definition.responses["201"];delete op.override;return op;
}
test("new cluster request 201 uses only its declared 200 DTO and preserves duplicate replies, shared schemas and caller metadata",()=>{
  const target=uncorrected(),other=structuredClone(operation("getClusterGroupRequestsForGroup")),input=[target,other],before=structuredClone(input),c=structuredClone(contract),contractBefore=structuredClone(c);
  const schemas=structuredClone(registry.schemas),schemaBefore=structuredClone(schemas),result=applyResponseCorrections(input,schemas,registry.secretRules,c,baseline);
  assert.deepEqual(input,before);assert.deepEqual(schemas,schemaBefore);assert.deepEqual(c,contractBefore);
  assert.deepEqual(result.map(o=>[o.operationId,o.method,o.path]),input.map(o=>[o.operationId,o.method,o.path]));
  assert.deepEqual(result[0]!.auth,target.auth);assert.deepEqual(result[0]!.parameters,target.parameters);assert.deepEqual(result[1],other);
  assert.deepEqual(result[0]!.definition.responses["200"],target.definition.responses["200"]);
  assert.deepEqual(result[0]!.definition.responses["201"].content["application/json"].schema,{$ref:"#/components/schemas/ClusterGroupRequestResponseDto"});
  assert.ok(describe("createClusterGroupRequest").overrides?.facts.some((f:any)=>f.fact_id===contract.corrections[0].fact_id&&f.value.runtime_verified===false));
  result[0]!.definition.responses["201"].content["application/json"].schema.$ref="#/components/schemas/UserResponseDto";
  result[0]!.override!.facts.at(-1).source_urls.push("https://example.com/unreviewed");
  assert.deepEqual(input,before);assert.deepEqual(c,contractBefore);assert.deepEqual(schemas,schemaBefore);
});
test("cluster status correction rejects stale routes/DTOs, duplicate targets and invalid source metadata before any alias is added",()=>{
  const changes=[
    (c:any)=>{c.openapi_sha256="wrong";},(c:any)=>{c.source_commit="wrong";},(c:any)=>{c.immich_version="latest";},
    (c:any)=>{c.corrections[0].operation_id="getClusterGroupRequests";},(c:any)=>{c.corrections[0].http_method="POST";},
    (c:any)=>{c.corrections[0].api_relative_path="/wrong";},(c:any)=>{c.corrections[0].openapi_operation_pointer="#/paths/wrong";},
    (c:any)=>{c.corrections[0].status_code=200;},(c:any)=>{c.corrections[0].status_code=400;},(c:any)=>{c.corrections[0].schema_from_status_code=201;},
    (c:any)=>{c.corrections[0].schema_ref="#/components/schemas/UserResponseDto";},(c:any)=>{c.corrections[0].content_type="text/plain";},
    (c:any)=>{c.corrections[0].source_urls=[];},(c:any)=>{c.corrections[0].source_urls.push(c.corrections[0].source_urls[0]);},
    (c:any)=>{c.corrections[0].source_urls=["https://example.com/source"];},
    (c:any)=>{c.corrections[0].source_urls=[c.corrections[0].source_urls[0].replace("github.com","githubXcom")];},
    (c:any)=>{c.corrections[0].source_urls=[c.corrections[0].source_urls[0].replace("/controllers/","/../controllers/")];},
    (c:any)=>{c.corrections[0].fact_id=null;},(c:any)=>{c.corrections[0].arbitrary_schema={};},
    (c:any)=>{c.corrections.push(structuredClone(c.corrections[0]));}
  ];
  for(const change of changes){
    const c=structuredClone(contract),input=[uncorrected()],before=structuredClone(input);change(c);
    assert.throws(()=>applyResponseCorrections(input,registry.schemas,registry.secretRules,c,baseline));assert.deepEqual(input,before);
  }
  assert.throws(()=>applyResponseCorrections([uncorrected(),uncorrected()],registry.schemas,registry.secretRules,contract,baseline));
  const a=structuredClone(operation("createActivity"));delete a.definition.responses["200"];delete a.override;
  const input=[a,uncorrected()],before=structuredClone(input),combined={...contract,corrections:[...structuredClone(activity.corrections),...structuredClone(contract.corrections)]};
  combined.corrections[1].schema_ref="#/components/schemas/UserResponseDto";
  assert.throws(()=>applyResponseCorrections(input,registry.schemas,registry.secretRules,combined,baseline));assert.deepEqual(input,before);
});
test("a source-status secret needs identical target protection; wildcard rules and duplicate facts cannot bypass cluster correction checks",()=>{
  const source={operation_id:"createClusterGroupRequest",direction:"response",status_code:200,instance_pointer_pattern:"/id"};
  const input=[uncorrected()],before=structuredClone(input);
  assert.throws(()=>applyResponseCorrections(input,registry.schemas,[{bindings:[source]}],contract,baseline),/secret coverage/);assert.deepEqual(input,before);
  const target={...source,status_code:201};
  assert.ok(applyResponseCorrections(input,registry.schemas,[{bindings:[source,target]}],contract,baseline)[0]);
  assert.throws(()=>applyResponseCorrections(input,registry.schemas,[{bindings:[source,{...target,instance_pointer_pattern:"/other"}]}],contract,baseline),/secret coverage/);
  assert.throws(()=>applyResponseCorrections(input,registry.schemas,[{bindings:[{...source,operation_id:"*"}]}],contract,baseline),/wildcard secret/);
  assert.ok(applyResponseCorrections(input,registry.schemas,[{bindings:[{...source,direction:"request"}]}],contract,baseline)[0]);
  const fact=uncorrected();fact.override={facts:[{fact_id:contract.corrections[0].fact_id}]} as any;
  assert.throws(()=>applyResponseCorrections([fact],registry.schemas,registry.secretRules,contract,baseline),/Duplicate response correction fact/);
});
test("native HTTP exposes new and duplicate cluster request IDs while unknown statuses, unreviewed fields and other operations stay protected",async()=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,"immich-cluster-correction-"));assert.equal(dirname(await realpath(root)),parent);
  const v=new Vault(root,randomBytes(32),"test",":memory:"),group="11111111-1111-4111-8111-111111111111",user="22222222-2222-4222-8222-222222222222",
    dto={id:"33333333-3333-4333-8333-333333333333",clusterGroupId:group,userId:user,createdAt:"2026-11-10T00:00:00.000Z"},canary="UNREVIEWED-CLUSTER-CREDENTIAL-CANARY";
  const create:ApiCall={operation_id:"createClusterGroupRequest",path:{id:group},body:{userId:user}};
  const scenarios:{call:ApiCall;status:number;body:any;diagnostic:string|null}[]=[
    {call:create,status:201,body:dto,diagnostic:null},{call:create,status:200,body:dto,diagnostic:null},
    {call:create,status:201,body:{...dto,id:17},diagnostic:"response_schema_mismatch"},
    {call:create,status:201,body:{...dto,unreviewedCredential:canary},diagnostic:"projection_mismatch"},
    {call:create,status:202,body:dto,diagnostic:"artifact_result"},
    {call:{operation_id:"getClusterGroupRequestsForGroup",path:{id:group}},status:200,body:[dto],diagnostic:null},
    {call:{operation_id:"getUniqueOriginalPaths"},status:201,body:dto,diagnostic:"artifact_result"}
  ];
  let count=0;const errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      const expected=scenarios[count++]!,op=operation(expected.call.operation_id),url=new URL(req.url!,"http://127.0.0.1");
      assert.equal(req.method,op.method);assert.equal(url.pathname,"/api"+op.path.replace("{id}",group));
      assert.equal(req.headers["x-api-key"],"synthetic-key-A");assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const bytes=Buffer.concat(chunks);
      if(expected.call.body)assert.deepEqual(JSON.parse(bytes.toString("utf8")),expected.call.body);else assert.equal(bytes.length,0);
      res.writeHead(expected.status,{"content-type":"application/json"});res.end(JSON.stringify(expected.body));
    }catch(error){errors.push((error as Error).name);res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const e=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",v);
  try{
    v.replaceBinding("A","synthetic-key-A","synthetic-key-id",0);
    for(const expected of scenarios){
      const result=await e.call("A",expected.call);
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
    const physical=await realpath(root);assert.equal(dirname(physical),parent);assert.ok(basename(physical).startsWith("immich-cluster-correction-"));await rm(physical,{recursive:true,force:true});
  }
});
