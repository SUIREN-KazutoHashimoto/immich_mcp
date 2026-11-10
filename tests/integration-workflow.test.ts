import test,{describe} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {prepareLab,upLab} from "../src/integration-lab.js";
import {bootstrapLab,fixtureServerId} from "../src/integration-bootstrap.js";
import {createWorkflowFixtures,WORKFLOW_PLAN} from "../src/integration-workflow-fixtures.js";
import {Vault} from "../src/vault.js";
import {BridgeError} from "../src/types.js";
import {registry} from "../src/registry.js";
import {setup,fakeDocker,state} from "./lab-harness.js";
import {seedHarnessAccounts} from "./media-harness.js";
import {workflowBackend} from "./workflow-harness.js";
const code=(expected:string)=>(e:unknown)=>e instanceof BridgeError&&e.code===expected;
const mutations=(calls:{method:string}[])=>calls.filter(c=>!["GET","HEAD"].includes(c.method)).length;
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",WORKFLOW_PLAN,"fixture_run");}finally{v.close();}
}
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,model,http}=workflowBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);return {base,root,runner,backend,model,http};
}
describe("owned workflow and installed core plugin fixtures",{concurrency:1},()=>{
test("native HTTP proves all twelve operations, favorite transitions, zero-index halted logs and read-only repeats",{timeout:3600000},async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-native-workflow-")),root=join(base,"run"),{backend,model,http}=workflowBackend(),errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("bounded workflow request");chunks.push(chunk);}
      const body=Buffer.concat(chunks),response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers:req.headers as any,
        ...(body.length?{body:body as any}:{}),redirect:"manual"});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error);res.writeHead(500,{"content-type":"application/json"});res.end('{"message":"synthetic workflow HTTP failure"}');}
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root);
    await upLab(root,{docker:runner});await bootstrapLab(root,{docker:runner});
    const result=await createWorkflowFixtures(root,{docker:runner});assert.equal(result.state,"workflow_fixtures_ready");
    assert.equal(result.execution_scope,"harness_only");assert.equal(result.full_acceptance,false);assert.equal(result.wasm_execution_trace_verified,false);
    assert.equal(model.workflows.length,2);assert.equal(model.assets.length,3);assert.equal(model.tags.length,2);assert.equal(model.logs.length,3);
    assert.ok(model.workflows.every(w=>!w.enabled&&w.logging&&w.steps.length===1));
    const saved=await journal(root);assert.equal(saved.case_limit,448);
    const favoriteIds=new Set([saved.data.assets.workflow_a1,saved.data.assets.workflow_a2]);
    for(const a of model.assets)assert.equal(a.favorite,favoriteIds.has(a.id));
    // Core20 +metadata60 +log80 +queue60 =220 polls; nominal11 =>209 spare.
    assert.ok(saved.cases.length+209<=448,"all bounded asynchronous observations fit the plan budget");
    const report=JSON.parse(await readFile(result.report,"utf8")),targets=registry.operations.filter(o=>["Workflows","Plugins"].includes(o.tag));
    assert.equal(targets.length,12);assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    for(const op of targets){
      const cases=report.operations.find((o:any)=>o.operation_id===op.operationId).cases;
      assert.ok(cases.some((c:any)=>c.kind==="success"&&c.state==="passed"),op.operationId+" positive");
      assert.ok(cases.some((c:any)=>c.actor==="restricted"&&c.status===(op.operationId==="getWorkflowTriggers"?200:403)&&c.state==="passed"),op.operationId+" scoped");
    }
    assert.ok(report.operations.every((o:any)=>o.real_success_cases===0&&o.integration_success==="not_run"));
    const text=JSON.stringify(report);
    for(const k of backend.keys)assert.ok(!text.includes(k.secret));for(const u of backend.users)assert.ok(!text.includes(u.password));
    assert.ok(!text.includes("WORKFLOW-CONFIG-CANARY"));
    const before={flows:structuredClone(model.workflows),logs:structuredClone(model.logs),assets:model.assets.map(a=>({id:a.id,favorite:a.favorite,tags:[...a.tags]}))};
    backend.calls.length=0;const repeated=await createWorkflowFixtures(root,{docker:runner});
    assert.equal(repeated.state,"workflow_fixtures_revalidated");assert.equal(mutations(backend.calls),0);
    assert.deepEqual(model.workflows,before.flows);assert.deepEqual(model.logs,before.logs);
    assert.deepEqual(model.assets.map(a=>({id:a.id,favorite:a.favorite,tags:[...a.tags]})),before.assets);
    const repeatedJournal=await journal(root);assert.ok(repeatedJournal.validation.cases.length>40);
    assert.ok(repeatedJournal.validation.cases.every((c:any)=>!c.mutates&&c.state==="passed"));
    const a2=model.assets.find(a=>a.filename.includes("workflow_a2"))!;a2.favorite=false;backend.calls.length=0;
    await assert.rejects(createWorkflowFixtures(root,{docker:runner}),code("fixture_validation_failed"));
    assert.equal(mutations(backend.calls),0);assert.equal((await journal(root)).state,"completed");assert.deepEqual(errors,[]);
    t.diagnostic("initial_cases="+saved.cases.length+" readonly_repeat="+repeatedJournal.validation.cases.length);
  }catch(error){
    try{const s=await journal(root),c=s.cases.at(-1);t.diagnostic("last_case="+JSON.stringify({id:c?.id,state:c?.state,status:c?.status,diagnostic:c?.diagnostic_code}));}catch{}
    t.diagnostic("server_errors="+JSON.stringify(errors.map(e=>({name:(e as any)?.name,code:(e as any)?.code}))));throw error;
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(base,{recursive:true,force:true});}
});
test("a lost workflow creation acknowledgement fences every recreation, upload and configuration write",{timeout:600000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostCreate=true;await assert.rejects(createWorkflowFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const s=await journal(root);assert.equal(s.cases.at(-1).id,"create_favorite");assert.equal(s.cases.at(-1).state,"outcome_unknown");
    assert.equal(model.workflows.length,1);assert.equal(model.assets.length,0);const count=mutations(backend.calls);model.lostCreate=false;
    await assert.rejects(createWorkflowFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));assert.equal(mutations(backend.calls),count);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("pre-existing locked trash prevents any workflow creation or upload",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.assets.push({id:"foreign-history",owner:backend.users.find(u=>u.name==="a")!,visibility:"locked",trashed:true});
    const count=mutations(backend.calls);await assert.rejects(createWorkflowFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    assert.equal((await journal(root)).cases.at(-1).id,"baseline_a_locked_trash");assert.equal(mutations(backend.calls),count);
  }finally{await rm(base,{recursive:true,force:true});}
});
for(const [fault,caseId]of [
  ["dropSteps","created_favorite_readback"],["enableNoEffect","enabled_favorite_readback"],
  ["favoriteNoEffect","first_favorite_effect"],["loggingClearNoEffect","logging_false_removed_old_logs"],
  ["badTriggerId","first_favorite_0"],["shareWrongDefault","favorite_share_true_default"],
  ["leakList","b_isolated_list"],["missingCoreMethod","initial_core_plugin_a"],
  ["restrictedWriteEffect","after_restrictions_favorite"]
]as const)test("schema-valid "+fault+" cannot certify a ready workflow fixture",{timeout:3600000},async()=>{
  const {base,root,runner,model,http}=await environment();
  try{
    model[fault]=true;await assert.rejects(createWorkflowFixtures(root,{docker:runner,http}),code("fixture_recovery_required"));
    const s=await journal(root);assert.equal(s.state,"recovery_required");assert.equal(s.cases.at(-1).id,caseId);
    assert.equal(s.cases.at(-1).diagnostic_code,"fixture_assertion");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("bundled core manifest bytes match the fixed official source",async()=>{
  assert.equal(createHash("sha256").update(await readFile(new URL("./workflow-core-manifest.fixture.json",import.meta.url))).digest("hex"),
    "9a670852a9504c377f3de7a8618576f4f1138da4fe7ce876103cd91baf6d9c57");
});
});
