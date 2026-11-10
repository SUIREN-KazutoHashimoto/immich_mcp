import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,rm,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,basename } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { applyResponseShapeCorrections } from "../scripts/response-shape-corrections.js";
import { registry,operation,describe } from "../src/registry.js";
import { Executor } from "../src/executor.js";
import { Vault } from "../src/vault.js";
const contract=JSON.parse(await readFile(new URL("../contracts/response-shape-corrections.v3.3.5.json",import.meta.url),"utf8"));
const baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
function uncorrected(){
  const op=structuredClone(operation("getSearchSuggestions"));
  op.definition.responses["200"].content["application/json"].schema={type:"array",items:{type:"string"}};delete op.override;return op;
}
test("nullable suggestion correction changes only the pinned inline response and preserves caller inputs and other operations",()=>{
  const target=uncorrected(),other=structuredClone(operation("getUniqueOriginalPaths"));
  other.definition.responses["200"].content["application/json"].schema=target.definition.responses["200"].content["application/json"].schema;
  const input=[target,other],before=structuredClone(input),result=applyResponseShapeCorrections(input,registry.secretRules,contract,baseline);
  assert.deepEqual(input,before);assert.deepEqual(result.map(o=>[o.operationId,o.method,o.path]),input.map(o=>[o.operationId,o.method,o.path]));
  assert.deepEqual(result[0]!.auth,input[0]!.auth);
  assert.deepEqual(result[0]!.definition.responses["200"].content["application/json"].schema,{type:"array",items:{type:"string",nullable:true}});
  assert.deepEqual(result[1]!.definition.responses["200"].content["application/json"].schema,{type:"array",items:{type:"string"}});
  assert.ok(describe("getSearchSuggestions").overrides?.facts.some((f:any)=>f.fact_id==="nullable_search_suggestion_items"&&f.value.runtime_verified===false));
  result[0]!.definition.responses["200"].content["application/json"].schema.items.type="object";assert.deepEqual(input,before);
});
test("stale fingerprints, arbitrary widening, duplicated targets and invalid source or operation metadata reject atomically",()=>{
  const changes=[
    (c:any)=>{c.openapi_sha256="wrong";},(c:any)=>{c.source_commit="wrong";},(c:any)=>{c.immich_version="latest";},
    (c:any)=>{c.corrections[0].operation_id="getUniqueOriginalPaths";},(c:any)=>{c.corrections[0].api_relative_path="/wrong";},
    (c:any)=>{c.corrections[0].http_method="POST";},(c:any)=>{c.corrections[0].openapi_operation_pointer="#/paths/wrong/get";},
    (c:any)=>{c.corrections[0].status_code=400;},(c:any)=>{c.corrections[0].status_code=201;},
    (c:any)=>{c.corrections[0].content_type="text/plain";},(c:any)=>{c.corrections[0].schema_pointer="/items/type";},
    (c:any)=>{c.corrections[0].correction="allow_everything";},(c:any)=>{c.corrections[0].expected_schema={type:"array",items:{}};},
    (c:any)=>{c.corrections[0].source_urls=[];},(c:any)=>{c.corrections[0].source_urls=["https://example.com/source"];},
    (c:any)=>{c.corrections[0].source_urls=[c.corrections[0].source_urls[0].replace("/services/","/../services/")];},
    (c:any)=>{c.corrections[0].fact_id=null;},(c:any)=>{delete c.corrections[0].fact_id;},
    (c:any)=>{c.corrections[0].arbitrary_schema={};},(c:any)=>{c.corrections.push(structuredClone(c.corrections[0]));}
  ];
  for(const change of changes){
    const c=structuredClone(contract),input=[uncorrected()],before=structuredClone(input);change(c);
    assert.throws(()=>applyResponseShapeCorrections(input,registry.secretRules,c,baseline));assert.deepEqual(input,before);
  }
  for(const schema of [{type:"array",items:{$ref:"#/components/schemas/UserResponseDto"}},{type:"array",items:{type:"string",nullable:true}},{type:"array",items:{type:"string"},nullable:true}]){
    const input=[uncorrected()];input[0]!.definition.responses["200"].content["application/json"].schema=schema;
    const before=structuredClone(input);assert.throws(()=>applyResponseShapeCorrections(input,registry.secretRules,contract,baseline),/schema mismatch/);assert.deepEqual(input,before);
  }
  const duplicate=[uncorrected(),uncorrected()];assert.throws(()=>applyResponseShapeCorrections(duplicate,registry.secretRules,contract,baseline));
});
test("response shape corrections cannot alter credential-bearing responses or reuse existing facts",()=>{
  const responseBinding={operation_id:"getSearchSuggestions",direction:"response",status_code:200,instance_pointer_pattern:"/*"};
  for(const binding of [responseBinding,{...responseBinding,operation_id:"*"},{...responseBinding,status_code:201}]){
    const input=[uncorrected()],before=structuredClone(input);assert.throws(()=>applyResponseShapeCorrections(input,[{bindings:[binding]}],contract,baseline),/secret-bearing/);assert.deepEqual(input,before);
  }
  assert.ok(applyResponseShapeCorrections([uncorrected()],[{bindings:[{...responseBinding,direction:"request"}]}],contract,baseline)[0]);
  const existing=uncorrected();existing.override={facts:[{fact_id:contract.corrections[0].fact_id}]} as any;
  assert.throws(()=>applyResponseShapeCorrections([existing],registry.secretRules,contract,baseline),/Duplicate response shape/);
});
test("native HTTP preserves nullable suggestion items while invalid items, unknown statuses and unrelated string arrays remain protected",async()=>{
  const tempParent=await realpath(tmpdir()),root=await mkdtemp(join(tempParent,"immich-null-suggestion-"));
  assert.equal(dirname(await realpath(root)),tempParent);
  const v=new Vault(root,randomBytes(32),"test",":memory:"),canary="UNREVIEWED-SUGGESTION-CREDENTIAL-CANARY";
  const scenarios=[
    {operation:"getSearchSuggestions",includeNull:false,status:200,body:["日本",""],state:"completed",diagnostic:null},
    {operation:"getSearchSuggestions",includeNull:true,status:200,body:["日本",null,""],state:"completed",diagnostic:null},
    {operation:"getSearchSuggestions",includeNull:true,status:200,body:[{unexpectedCredential:canary}],state:"failed",diagnostic:"response_schema_mismatch"},
    {operation:"getSearchSuggestions",includeNull:true,status:201,body:["日本",null],state:"completed",diagnostic:"artifact_result"},
    {operation:"getSearchSuggestions",includeNull:true,status:200,body:[7],state:"failed",diagnostic:"response_schema_mismatch"},
    {operation:"getUniqueOriginalPaths",includeNull:false,status:200,body:[null],state:"failed",diagnostic:"response_schema_mismatch"}
  ];
  let count=0;const errors:string[]=[];
  const server=createServer((req,res)=>{
    try{
      const expected=scenarios[count++]!,url=new URL(req.url!,"http://127.0.0.1");assert.equal(req.method,"GET");
      assert.equal(url.pathname,expected.operation==="getSearchSuggestions"?"/api/search/suggestions":"/api/view/folder/unique-paths");
      if(expected.operation==="getSearchSuggestions"){assert.equal(url.searchParams.get("type"),"country");assert.equal(url.searchParams.get("includeNull"),String(expected.includeNull));}
      assert.equal(req.headers["x-api-key"],"synthetic-key-A");assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
      res.writeHead(expected.status,{"content-type":"application/json"});res.end(JSON.stringify(expected.body));
    }catch(error){errors.push((error as Error).name);res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const e=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",v);
  try{
    v.replaceBinding("A","synthetic-key-A","synthetic-key-id",0);
    for(const expected of scenarios){
      const result=await e.call("A",{operation_id:expected.operation,...(expected.operation==="getSearchSuggestions"?{query:{type:"country",includeNull:expected.includeNull}}:{})});
      assert.equal(result.upstream?.status,expected.status);assert.equal(result.state,expected.state);assert.equal(result.diagnostic?.code??null,expected.diagnostic);
      if(expected.diagnostic===null)assert.deepEqual(result.data,expected.body);else assert.equal(result.data,null);
      assert.ok(!JSON.stringify(result).includes(canary));
      const saved=v.get("A",result.result_ref!,"result"),raw=await new Response(v.rawStream("A",saved.raw.raw_ref) as any).text();
      assert.equal(raw,JSON.stringify(expected.body));assert.throws(()=>v.get("B",result.result_ref!,"result"));
    }
    assert.equal(count,scenarios.length);assert.deepEqual(errors,[]);
  }finally{
    await e.close();v.close();server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));
    const physical=await realpath(root);assert.equal(dirname(physical),tempParent);assert.ok(basename(physical).startsWith("immich-null-suggestion-"));await rm(physical,{recursive:true,force:true});
  }
});
