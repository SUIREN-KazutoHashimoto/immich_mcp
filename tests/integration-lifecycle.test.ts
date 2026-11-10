import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { bootstrapLab,fixtureServerId } from "../src/integration-bootstrap.js";
import { createLifecycleFixtures,LIFECYCLE_PLAN } from "../src/integration-lifecycle-fixtures.js";
import { BridgeError } from "../src/types.js";
import { Vault } from "../src/vault.js";
import { registry } from "../src/registry.js";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { lifecycleBackend } from "./lifecycle-harness.js";

const code=(expected:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===expected;
const mutations=(calls:{method:string;path:string}[])=>calls.filter(c=>c.path==="/api/duplicates"&&c.method==="GET"||
  !["GET","HEAD"].includes(c.method)&&!(c.method==="POST"&&c.path==="/api/search/metadata")).length;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,model,http}=lifecycleBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);return {base,root,runner,backend,model,http};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return vault.get("__integration_feature_runs",LIFECYCLE_PLAN,"fixture_run");}finally{vault.close();}
}
describe("asset file duplicate and trash lifecycle",{concurrency:2},()=>{
test("native HTTP proves all eleven operations, exact merge/readback state and completed read-only validation",{timeout:3600000},async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-native-lifecycle-")),root=join(base,"run"),{backend,model,http}=lifecycleBackend(),errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("bounded lifecycle request");chunks.push(chunk);}
      const body=Buffer.concat(chunks),r=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers:req.headers as any,
        ...(body.length?{body:body as any}:{}),redirect:"manual"});
      res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
    }catch(error){errors.push(error);res.writeHead(500,{"content-type":"application/json"});res.end('{"message":"synthetic lifecycle HTTP failure"}');}
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root);
    await upLab(root,{docker:runner});await bootstrapLab(root,{docker:runner});
    const r=await createLifecycleFixtures(root,{docker:runner});assert.equal(r.state,"lifecycle_fixtures_ready");assert.equal(r.execution_scope,"harness_only");
    assert.equal(r.physical_deletion_verified,false);assert.equal(r.machine_learning_duplicate_detection_verified,false);
    assert.equal(model.assets.length,7);assert.equal(model.albums.length,2);assert.equal(model.tags.length,2);
    assert.equal(model.queues.duplicateDetection!.isPaused,false);
    const saved=await journal(root);assert.equal(saved.case_limit,448);
    //2 metadata40 +2 file40 +5 queue waits100 +background20 =>200.
    //Nominal readiness uses11 receipts; all remaining189 must fit.
    assert.ok(saved.cases.length+189<=448,"bounded asynchronous observations must fit the authenticated plan limit");
    const report=JSON.parse(await readFile(r.report,"utf8")),targets=registry.operations.filter(o=>["Asset files","Duplicates","Trash"].includes(o.tag));
    assert.equal(targets.length,11);assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    for(const op of targets){
      const cases=report.operations.find((o:any)=>o.operation_id===op.operationId).cases;
      assert.ok(cases.some((c:any)=>c.kind==="success"&&c.state==="passed"),op.operationId);
      assert.ok(cases.some((c:any)=>c.actor==="restricted"&&c.kind==="refusal"&&c.status===403&&c.state==="passed"),op.operationId);
    }
    assert.equal(report.full_acceptance,false);assert.ok(report.operations.every((o:any)=>o.real_success_cases===0&&o.integration_success==="not_run"));
    const encoded=JSON.stringify(report);for(const k of backend.keys)assert.ok(!encoded.includes(k.secret));for(const u of backend.users)assert.ok(!encoded.includes(u.password));
    for(const value of ["file_ref","result_ref","secret_ref","example.invalid"])assert.ok(!encoded.includes(value));
    const cleanup=model.cleanupCalls;assert.ok(cleanup>0);
    for(const a of model.assets)a.duplicateId=randomUUID(); // Legitimate resumed worker evolution.
    backend.calls.length=0;const repeated=await createLifecycleFixtures(root,{docker:runner});
    assert.equal(repeated.state,"lifecycle_fixtures_revalidated");assert.equal(mutations(backend.calls),0);assert.equal(model.cleanupCalls,cleanup);
    const validation=await journal(root);assert.ok(validation.validation.cases.length>25);assert.ok(validation.validation.cases.every((c:any)=>!c.mutates&&c.state==="passed"));
    model.assets.find(a=>a.filename.includes("lifecycle_a5"))!.favorite=false;backend.calls.length=0;
    await assert.rejects(createLifecycleFixtures(root,{docker:runner}),code("fixture_validation_failed"));
    const changed=await journal(root);assert.equal(changed.state,"completed");assert.equal(changed.validation.state,"failed");
    assert.equal(changed.validation.cases.at(-1).id,"final_lifecycle_a5");assert.equal(changed.validation.cases.at(-1).diagnostic_code,"fixture_assertion");
    assert.equal(mutations(backend.calls),0);assert.equal(model.cleanupCalls,cleanup);assert.equal(errors.length,0);
    t.diagnostic("initial_cases="+saved.cases.length+" readonly_repeat="+validation.validation.cases.length);
  }catch(error){
    try{const s=await journal(root),c=s.cases.at(-1);t.diagnostic("last_case="+JSON.stringify({id:c?.id,state:c?.state,status:c?.status,diagnostic:c?.diagnostic_code}));}catch{}
    t.diagnostic("server_errors="+JSON.stringify(errors.map(e=>({name:(e as any)?.name,code:(e as any)?.code}))));throw error;
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(base,{recursive:true,force:true});}
});
test("an originally paused duplicate queue remains paused after successful lifecycle setup",{timeout:3600000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.queues.duplicateDetection!.isPaused=true;
    const r=await createLifecycleFixtures(root,{docker:runner,http});assert.equal(r.state,"lifecycle_fixtures_ready");assert.equal(model.queues.duplicateDetection!.isPaused,true);
    assert.ok(!backend.calls.some(c=>c.path==="/api/queues/duplicateDetection"&&c.method==="PUT"&&c.body?.isPaused===false));
  }finally{await rm(base,{recursive:true,force:true});}
});
test("pre-existing locked trash stops the fresh-lab scenario before pausing queues or uploading",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.assets.push({id:"pre-existing",owner:backend.users.find(u=>u.name==="a")!,visibility:"locked",trashed:true,status:"trashed"});
    const count=mutations(backend.calls);await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const failed=(await journal(root)).cases.at(-1);assert.equal(failed.id,"baseline_a_locked_trash");assert.equal(failed.diagnostic_code,"fixture_assertion");
    assert.equal(mutations(backend.calls),count);assert.equal(model.queues.duplicateDetection!.isPaused,false);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("a lost pause acknowledgement fences all subsequent queue and asset mutations",{timeout:600000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostPauseReply=true;await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const s=await journal(root);assert.equal(s.cases.at(-1).id,"pause_duplicate_queue");assert.equal(s.cases.at(-1).state,"outcome_unknown");
    assert.equal(model.assets.length,0);assert.equal(model.queues.duplicateDetection!.isPaused,true);
    const count=mutations(backend.calls);model.lostPauseReply=false;
    await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));assert.equal(mutations(backend.calls),count);
  }finally{await rm(base,{recursive:true,force:true});}
});
for(const [fault,caseId,diagnostic] of [
  ["queuePauseNoEffect","duplicate_pause_readback_0","fixture_assertion"],
  ["fileDeleteNoEffect","deleted_preview_search_readback","fixture_assertion"],
  ["singletonNoEffect","singleton_cleanup_readback","fixture_assertion"],
  ["mergeNoEffect","merged_keeper_readback","fixture_assertion"],
  ["restoreNoEffect","selected_restore_readback","fixture_assertion"],
  ["emptyWrongOwner","empty_trash_marked_deleted","fixture_assertion"],
  ["missingDeletionJob","deleted_asset_api_absent","fixture_observation"],
  ["metadataNoEffect","keeper_metadata_readback","fixture_assertion"],
  ["queueResumeNoEffect","restored_duplicate_queue","fixture_assertion"]
] as const)test("schema-valid "+fault+" responses cannot publish ready lifecycle fixtures",{timeout:3600000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model[fault]=true;await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const s=await journal(root),failed=s.cases.at(-1);assert.equal(failed.id,caseId);assert.equal(failed.state,"failed");
    assert.equal(failed.diagnostic_code,diagnostic);assert.equal(failed.status,200);
    const count=mutations(backend.calls);await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    assert.equal(mutations(backend.calls),count);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("a valid JPEG from another owner is detected by the distinct fixture-byte readback",{timeout:1200000},async()=>{
  const {base,root,runner,model,http}=await environment();
  try{
    model.wrongOwnerFileBytes=true;await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const failed=(await journal(root)).cases.at(-1);assert.equal(failed.id,"download_b_preview");assert.equal(failed.diagnostic_code,"fixture_assertion");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("a schema-valid partial file response with changed bytes fails the Range readback",{timeout:1200000},async()=>{
  const {base,root,runner,model,http}=await environment();
  try{
    model.rangeWrongBytes=true;await assert.rejects(createLifecycleFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const failed=(await journal(root)).cases.at(-1);
    assert.equal(failed.id,"range_a_preview");assert.equal(failed.status,206);assert.equal(failed.diagnostic_code,"fixture_assertion");
  }finally{await rm(base,{recursive:true,force:true});}
});

});
