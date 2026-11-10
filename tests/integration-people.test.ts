import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { bootstrapLab,withInitializedFixtureLab,fixtureServerId } from "../src/integration-bootstrap.js";
import { createPeopleFixtures,PEOPLE_PLAN } from "../src/integration-people-fixtures.js";
import { IntegrationRun } from "../src/integration-run.js";
import { profileImageFrame } from "../src/integration-profile-image.js";
import { registry } from "../src/registry.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { peopleBackend } from "./people-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const mutations=(calls:{method:string;path:string}[])=>calls.filter(c=>!["GET","HEAD"].includes(c.method)&&!(c.method==="POST"&&c.path==="/api/search/metadata")).length;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,model,http}=peopleBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);return {base,root,runner,backend,model,http};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return vault.get("__integration_feature_runs",PEOPLE_PLAN,"fixture_run");}finally{vault.close();}
}
describe("isolated people/faces/cluster fixtures",{concurrency:3},()=>{
test("all 27 operations use native HTTP, geometry and distinct-asset readbacks, scoped sharing and nonempty cluster remapping", {timeout:2400000},async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-native-people-")),root=join(base,"run"),{backend,model,http}=peopleBackend(),errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("bounded synthetic request");chunks.push(chunk);}
      const body=Buffer.concat(chunks),response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers:req.headers as any,
        ...(body.length?{body:body as any}:{}),redirect:"manual"});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error);res.writeHead(500,{"content-type":"application/json"});res.end('{"message":"synthetic HTTP failure"}');}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root);
    await upLab(root,{docker:runner});await bootstrapLab(root,{docker:runner});
    const result=await createPeopleFixtures(root,{docker:runner});assert.equal(result.state,"people_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    assert.equal(result.machine_learning_inference,"not_verified");assert.equal(model.assets.length,3);assert.equal(model.people.length,3);
    assert.equal(model.faces.filter(f=>!f.deleted).length,6);assert.equal(model.faces.filter(f=>f.deleted).length,1);
    assert.equal(model.albums.length,1);assert.equal(model.requests.length,0);assert.equal(model.shares.length,0);
    const saved=await journal(root);assert.equal(saved.case_limit,384);assert.ok(saved.cases.length+133<=384,"all bounded metadata/thumbnail polls must fit the plan limit");
    assert.notEqual(saved.data.people.remapped,saved.data.people.alpha);
    assert.notEqual(saved.data.groups.b_final,saved.data.groups.a);assert.notEqual(saved.data.groups.b_final,saved.data.groups.b);
    assert.equal(model.people.find(p=>p.id===saved.data.people.beta)!.owner.clusterGroupId,saved.data.groups.b_final);
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    const target=registry.operations.filter(op=>["People","Faces","Cluster groups"].includes(op.tag));assert.equal(target.length,27);
    for(const op of target){
      const cases=report.operations.find((r:any)=>r.operation_id===op.operationId).cases;
      assert.ok(cases.some((c:any)=>c.kind==="success"&&c.state==="passed"),op.operationId+" needs a positive workflow");
      assert.ok(cases.some((c:any)=>c.actor==="restricted"&&c.kind==="refusal"&&c.status===403&&c.state==="passed"),op.operationId+" needs a scope refusal");
    }
    assert.ok(report.operations.find((o:any)=>o.operation_id==="searchPerson").cases.some((c:any)=>c.kind==="success"));
    assert.equal(report.full_acceptance,false);assert.equal(report.completed_41_category_acceptance,false);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.integration_success==="not_run"));
    const text=JSON.stringify(report);for(const k of backend.keys)assert.ok(!text.includes(k.secret));for(const u of backend.users)assert.ok(!text.includes(u.password));
    for(const forbidden of ["file_ref","result_ref","secret_ref","example.invalid"])assert.ok(!text.includes(forbidden));
    const names=backend.users.map(u=>u.name),keys=backend.keys.map(k=>k.secret);backend.calls.length=0;
    const again=await createPeopleFixtures(root,{docker:runner});assert.equal(again.state,"people_fixtures_revalidated");
    assert.equal(mutations(backend.calls),0);assert.deepEqual(backend.users.map(u=>u.name),names);assert.deepEqual(backend.keys.map(k=>k.secret),keys);
    const repeated=await journal(root);assert.ok(repeated.validation.cases.length>30);
    assert.ok(repeated.validation.cases.every((c:any)=>!c.mutates&&c.state==="passed"));
    model.people.find(p=>p.id===saved.data.people.alpha)!.name="external state change";backend.calls.length=0;
    await assert.rejects(createPeopleFixtures(root,{docker:runner}),isCode("fixture_validation_failed"));assert.equal(mutations(backend.calls),0);
    const failed=await journal(root);assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");
    assert.equal(failed.validation.cases.at(-1).id,"final_alpha");assert.equal(failed.validation.cases.at(-1).diagnostic_code,"fixture_assertion");
    assert.equal(errors.length,0);t.diagnostic("initial_cases="+saved.cases.length+" readonly_repeat="+repeated.validation.cases.length);
  }catch(error){
    try{const state=await journal(root),c=state.cases.at(-1);t.diagnostic("last_case="+JSON.stringify({id:c?.id,state:c?.state,status:c?.status,diagnostic:c?.diagnostic_code,assertions:c?.assertions}));}catch{}
    t.diagnostic("server_errors="+JSON.stringify(errors.map(e=>({name:(e as any)?.name,message:(e as any)?.message}))));throw error;}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(base,{recursive:true,force:true});}
});
test("a committed face insert with lost acknowledgement fences all repeated uploads, people and face mutations",{timeout:600000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostFaceReply=true;await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.faces.length,1);const saved=await journal(root);assert.equal(saved.cases.at(-1).id,"create_face_afirst");
    assert.equal(saved.cases.at(-1).state,"outcome_unknown");const count=mutations(backend.calls);
    model.lostFaceReply=false;await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(mutations(backend.calls),count);assert.equal(model.assets.length,3);assert.equal(model.faces.length,1);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("another feature history stops the dedicated scenario before any upstream mutation",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async context=>{new IntegrationRun(context,"other_feature_v1");},{docker:runner,http});
    const count=mutations(backend.calls);await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.diagnostic_code,"fixture_pristine_lab");assert.equal(saved.cases.length,0);
    assert.equal(mutations(backend.calls),count);assert.equal(model.assets.length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("hidden trashed assets are detected by explicit pristine-lab statistics before mutations",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.assets.push({id:"existing",owner:backend.users.find(u=>u.name==="a")!,visibility:"hidden",trashed:true});
    const count=mutations(backend.calls);await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),failed=saved.cases.at(-1);assert.equal(failed.id,"baseline_assets_a_hidden_trash");
    assert.equal(failed.diagnostic_code,"fixture_assertion");assert.equal(mutations(backend.calls),count);
    assert.equal(model.people.length,0);assert.equal(model.faces.length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});
for(const [fault,caseId] of [
  ["dropInvitation","incoming_invite_b"],["joinNoEffect","joined_user_readback"],["shareWrongRole","share_write_readback"],
  ["reassignNoEffect","single_face_readback"],["legacyMergeNoEffect","legacy_merge_face_readback"],["leaveNoRemap","discover_remapped_person"]
] as const)test("a schema-valid but ineffective "+fault+" response fails its semantic readback",{timeout:1800000},async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model[fault]=true;await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),failed=saved.cases.at(-1);assert.equal(failed.id,caseId);assert.equal(failed.state,"failed");
    assert.equal(failed.diagnostic_code,"fixture_assertion");assert.equal(failed.status,200);
    const count=mutations(backend.calls);await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(mutations(backend.calls),count);assert.equal(saved.state,"recovery_required");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("binary 200 with invalid JPEG bytes cannot establish a face thumbnail",{timeout:600000},async()=>{
  const {base,root,runner,model,http}=await environment();
  try{
    model.badThumbnail=true;await assert.rejects(createPeopleFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const failed=(await journal(root)).cases.at(-1);assert.equal(failed.id,"thumbnail_poll_alpha_first_0");assert.equal(failed.status,200);
    assert.equal(failed.diagnostic_code,"fixture_profile_image");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("the independent synthetic JPEG oracle decodes at its declared dimensions in a real browser",{timeout:90000},async()=>{
  const oracle=JSON.parse(await readFile(new URL("./people-thumbnail-oracle.json",import.meta.url),"utf8"));
  assert.equal(oracle.scope,"synthetic_harness_frame_and_byte_changes_not_upstream_crop_or_inference");
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  try{
    const hashes=new Set<string>(),page=await browser.newPage();
    for(const image of Object.values<any>(oracle.variants)){
      const bytes=Buffer.from(image.base64,"base64");assert.equal(createHash("sha256").update(bytes).digest("hex"),image.sha256);
      assert.deepEqual(profileImageFrame(bytes,image.mime),{format:"jpeg",width:22,height:22});hashes.add(image.sha256);
      await page.setContent('<img id="thumb" src="data:image/jpeg;base64,'+image.base64+'">');
      assert.deepEqual(await page.locator("#thumb").evaluate(async(img:any)=>{await img.decode();return [img.naturalWidth,img.naturalHeight];}),[22,22]);
    }assert.equal(hashes.size,3);
  }finally{await browser.close();}
});
});
