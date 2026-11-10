import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {createServer} from "node:http";
import {once} from "node:events";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {applyWorkflowLogIndexCorrection} from "../scripts/workflow-log-response-correction.js";
import {operation,registry,describe} from "../src/registry.js";
import {validator} from "../src/schema.js";
import {prepare} from "../src/serializer.js";
import {Executor} from "../src/executor.js";
import {Vault} from "../src/vault.js";
import {sample,uuid} from "./fixtures.js";

const contract=JSON.parse(await readFile(new URL("../contracts/workflow-log-index-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const api=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
const baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
function uncorrected(){
  const op=structuredClone(operation("getWorkflowLogs"));
  op.definition=structuredClone(api.paths["/workflows/{id}/logs"].get);delete op.override;
  return [op,structuredClone(operation("getPerson"))];
}
const log=(index:number)=>({...sample(registry.schemas.WorkflowLogEntryDto!),result:"halted",
  lastStep:{method:uuid+"#assetFileFilter",index}});

test("workflow log correction detaches one private response entry while preserving global components, inputs and other operations",()=>{
  const input=uncorrected(),before=structuredClone(input),schemas=structuredClone(registry.schemas);
  const corrected=applyWorkflowLogIndexCorrection(input,registry.schemas,contract,baseline),op=corrected[0]!;
  assert.deepEqual(input,before);assert.deepEqual(registry.schemas,schemas);assert.deepEqual(corrected[1],before[1]);
  assert.equal(op.operationId,before[0]!.operationId);assert.equal(op.path,before[0]!.path);assert.equal(op.method,"GET");
  assert.deepEqual(op.parameters,before[0]!.parameters);assert.deepEqual(op.auth,before[0]!.auth);
  assert.deepEqual(Object.keys(op.definition.responses),["200"]);
  const entry=op.definition.responses["200"].content["application/json"].schema.items;
  assert.equal(entry.properties.lastStep.properties.index.exclusiveMinimum,undefined);
  assert.equal(entry.properties.lastStep.properties.index.minimum,0);
  assert.equal(entry.properties.lastStep.properties.index.maximum,Number.MAX_SAFE_INTEGER);
  const restored=structuredClone(entry);restored.properties.lastStep.properties.index.exclusiveMinimum=true;
  assert.deepEqual(restored,registry.schemas.WorkflowLogEntryDto);
  entry.properties.lastStep.properties.index.minimum=999;
  assert.deepEqual(input,before);assert.deepEqual(registry.schemas,schemas);
  assert.ok(describe("getWorkflowLogs").overrides?.facts.some((f:any)=>f.fact_id==="workflow_log_zero_based_step_index"));
});

test("workflow log correction rejects stale fingerprints, identities, fields, sources, duplicate targets and prior application atomically",()=>{
  const changes=[
    (c:any)=>{c.openapi_sha256="wrong";},(c:any)=>{c.source_commit="wrong";},(c:any)=>{c.immich_version="latest";},
    (c:any)=>{c.operation_id="getPlugin";},(c:any)=>{c.http_method="POST";},(c:any)=>{c.api_relative_path="/other";},
    (c:any)=>{c.openapi_operation_pointer="#/paths/other/get";},(c:any)=>{c.status_code=201;},(c:any)=>{c.content_type="text/plain";},
    (c:any)=>{c.component_name="PersonResponseDto";},(c:any)=>{c.component_sha256="wrong";},
    (c:any)=>{c.component_property_pointer="/properties/id";},(c:any)=>{c.source_urls=[];},
    (c:any)=>{c.source_urls.push(c.source_urls[0]);},(c:any)=>{c.extra="unexpected";}
  ];
  for(const change of changes){
    const c=structuredClone(contract);change(c);const input=uncorrected(),before=structuredClone(input);
    assert.throws(()=>applyWorkflowLogIndexCorrection(input,registry.schemas,c,baseline));assert.deepEqual(input,before);
  }
  const input=uncorrected(),before=structuredClone(input),changed=structuredClone(registry.schemas);
  changed.WorkflowLogEntryDto!.properties.lastStep.properties.index.minimum=1;
  assert.throws(()=>applyWorkflowLogIndexCorrection(input,changed,contract,baseline));assert.deepEqual(input,before);
  assert.throws(()=>applyWorkflowLogIndexCorrection([],registry.schemas,contract,baseline));
  assert.throws(()=>applyWorkflowLogIndexCorrection([input[0]!,input[0]!],registry.schemas,contract,baseline));
  const applied=applyWorkflowLogIndexCorrection(input,registry.schemas,contract,baseline),snapshot=structuredClone(applied);
  assert.throws(()=>applyWorkflowLogIndexCorrection(applied,registry.schemas,contract,baseline));assert.deepEqual(applied,snapshot);
  assert.throws(()=>applyWorkflowLogIndexCorrection(input,registry.schemas,contract,{...baseline,version:"latest"}));
});

test("only the workflow response accepts zero while negative, fractional, unsafe, null and nonnumeric indexes and invalid input limits still reject",async()=>{
  const corrected=applyWorkflowLogIndexCorrection(uncorrected(),registry.schemas,contract,baseline)[0]!;
  const schema=corrected.definition.responses["200"].content["application/json"].schema,check=validator(schema,registry.schemas);
  for(const n of [0,1,Number.MAX_SAFE_INTEGER])assert.doesNotThrow(()=>check([log(n)]));
  for(const n of [-1,0.5,Number.MAX_SAFE_INTEGER+1,null,"0",false]){
    const value=log(1);(value.lastStep as any).index=n;assert.throws(()=>check([value]));
  }
  assert.throws(()=>validator({$ref:"#/components/schemas/WorkflowLogEntryDto"},registry.schemas)(log(0)));
  await assert.rejects(prepare("http://immich.test/api",{operation_id:"getWorkflowLogs",path:{id:uuid},query:{limit:0}}));
});

test("native HTTP displays zero-based workflow logs with exact bounds while retaining unknown statuses, secrets and principal isolation",async()=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-workflow-log-response-"));
  const vault=new Vault(root,randomBytes(32),"test",":memory:");
  let index=0,status=200,extra=false,requests=0;const errors:string[]=[];
  const server=createServer((req,res)=>{
    try{
      assert.equal(req.method,"GET");assert.equal(req.url,"/api/workflows/"+uuid+"/logs?limit=10");
      assert.equal(req.headers["x-api-key"],"key-A");assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
      requests++;res.writeHead(status,{"content-type":"application/json"});
      res.end(JSON.stringify([{...log(index),...(extra?{unreviewedCredential:"UNKNOWN-LOG-SECRET-CANARY"}:{})}]));
    }catch(error){errors.push((error as Error).message);res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const executor=new Executor("http://127.0.0.1:"+(server.address() as any).port+"/api",vault);
  try{
    vault.replaceBinding("A","key-A",uuid,0);
    const call={operation_id:"getWorkflowLogs",path:{id:uuid},query:{limit:10}};
    for(const n of [0,1,Number.MAX_SAFE_INTEGER,-1,0.5,Number.MAX_SAFE_INTEGER+1]){
      index=n;const reply=await executor.call("A",call),valid=Number.isSafeInteger(n)&&n>=0;
      assert.equal(reply.upstream?.status,200);assert.equal(reply.state,valid?"completed":"failed");
      if(valid)assert.equal(reply.data[0].lastStep.index,n);else assert.equal(reply.data,null);
      const saved=vault.get("A",reply.result_ref!,"result");
      assert.throws(()=>vault.get("B",reply.result_ref!,"result"));assert.throws(()=>vault.rawStream("B",saved.raw.raw_ref));
    }
    status=202;index=0;const unknown=await executor.call("A",call);
    assert.equal(unknown.upstream?.status,202);assert.equal(unknown.data,null);assert.equal(unknown.diagnostic?.code,"artifact_result");
    status=200;extra=true;const secret=await executor.call("A",call);
    assert.ok(!JSON.stringify(secret).includes("UNKNOWN-LOG-SECRET-CANARY"));
    const saved=vault.get("A",secret.result_ref!,"result");
    assert.ok((await new Response(vault.rawStream("A",saved.raw.raw_ref) as any).text()).includes("UNKNOWN-LOG-SECRET-CANARY"));
    assert.equal(requests,8);assert.deepEqual(errors,[]);
  }finally{
    await executor.close();vault.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    assert.ok(resolve(root).startsWith(parent+sep));await rm(root,{recursive:true,force:true});
  }
});
