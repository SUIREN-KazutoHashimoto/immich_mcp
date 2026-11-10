import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,basename } from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { fixtureServerId } from "../src/integration-bootstrap.js";
import { createDiscoveryFixtures,DISCOVERY_PLAN } from "../src/integration-discovery-fixtures.js";
import { registry } from "../src/registry.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { discoveryBackend } from "./discovery-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=discoveryBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedHarnessAccounts(root,backend.backend);return {base,root,runner,...backend};
}
async function removeOwnedBase(base:string){
  const parent=await realpath(tmpdir()),physical=await realpath(base);assert.equal(dirname(physical),parent);
  assert.ok(["immich-discovery-native-","immich-isolated-lab-"].some(prefix=>basename(physical).startsWith(prefix)));
  await rm(physical,{recursive:true,force:true});
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",DISCOVERY_PLAN,"fixture_run");}finally{v.close();}
}
describe("discovery semantic scenarios",{concurrency:2},()=>{
test("native HTTP verifies scoped legacy/structured search, aligned timeline arrays, maps and owned folders; completed repeat sends only original read cases",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-discovery-native-")),root=join(base,"run"),{backend,model,http}=discoveryBackend(),errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("test request bound");chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks),headers=new Headers(req.headers as Record<string,string>),body=bytes.length?
        (headers.get("content-type")?.includes("application/json")?bytes.toString("utf8"):bytes):undefined;
      const response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers,body,redirect:"manual"} as any);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error instanceof Error?error.name:"unknown");if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root),options={docker:runner};
    await upLab(root,options);await seedHarnessAccounts(root,backend);
    const result=await createDiscoveryFixtures(root,options).catch(async error=>{
      const saved=await journal(root),last=saved.cases.at(-1);
      t.diagnostic(JSON.stringify({case:last?.id,state:last?.state,status:last?.status,diagnostic:last?.diagnostic_code}));throw error;
    });
    assert.equal(result.state,"discovery_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    const saved=await journal(root);assert.equal(saved.cases.length,90);assert.ok(saved.cases.every((c:any)=>c.state==="passed"));
    assert.equal(model.assets.length,3);assert.equal(model.albums.length,3);assert.equal(model.partners.length,0);
    assert.ok(model.assets.every(a=>a.visibility==="timeline"));
    const expected=registry.operations.filter(o=>["Search","Timeline","Map","Views"].includes(o.tag)&&!["searchSmart","searchPerson"].includes(o.operationId)).map(o=>o.operationId).sort();
    assert.equal(expected.length,14);
    const observed=[...new Set<string>(saved.cases.filter((c:any)=>expected.includes(c.operation_id)&&c.kind==="success").map((c:any)=>c.operation_id))].sort();
    assert.deepEqual(observed,expected);
    for(const op of ["searchAssets","getTimeBuckets","getTimeBucket","getSearchSuggestions"])
      assert.ok(saved.cases.some((c:any)=>c.operation_id===op&&c.actor==="restricted"&&c.status===200));
    for(const op of ["searchAssetStatistics","searchPerson","getMapMarkers","reverseGeocode","getUniqueOriginalPaths","getAssetsByOriginalPath"])
      assert.ok(saved.cases.some((c:any)=>c.operation_id===op&&c.actor==="restricted"&&c.status===403));
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.equal(report.full_acceptance,false);assert.equal(report.api_integration_completed,false);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0&&op.integration_success==="not_run"));
    assert.deepEqual(result.conditional_positive_workflows,["searchSmart","searchPerson"]);
    const publicText=JSON.stringify(report);for(const secret of [...backend.keys.map(k=>k.secret),...backend.users.map(u=>u.password)])assert.equal(publicText.includes(secret),false);
    for(const field of ["file_ref","result_ref","secret_ref","context_ref","input"])assert.equal(publicText.includes('"'+field+'"'),false);
    const start=backend.calls.length,repeated=await createDiscoveryFixtures(root,options);
    assert.equal(repeated.state,"discovery_fixtures_revalidated");
    const history=await journal(root);assert.equal(history.validation.cases.length,50);
    assert.ok(history.validation.cases.every((c:any)=>!c.mutates&&c.state==="passed"));
    assert.ok(backend.calls.slice(start).every(c=>c.method==="GET"||c.method==="POST"&&/^\/api\/search\/(metadata|random|large-assets|statistics|smart)$/.test(c.path)));
    assert.equal(model.assets.length,3);assert.equal(model.partners.length,0);
    model.assets.find(a=>a.id===saved.data.assets.discovery_a_shared.id).favorite=false;
    await assert.rejects(createDiscoveryFixtures(root,options),isCode("fixture_validation_failed"));
    const failed=await journal(root);assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");
    assert.equal(failed.validation.cases.at(-1).id,"legacy_page_1_a");assert.equal(errors.length,0,errors.join(","));
  }finally{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));await removeOwnedBase(base);}
});
test("a lost upload acknowledgement fences all discovery writes after restart",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostUpload=true;await assert.rejects(createDiscoveryFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.cases.at(-1).id,"upload_discovery_a_shared");assert.equal(saved.cases.at(-1).state,"outcome_unknown");
    assert.equal(model.assets.length,1);assert.equal(model.albums.length,0);
    model.lostUpload=false;const before=backend.calls.length;
    await assert.rejects(createDiscoveryFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.assets.length,1);assert.ok(backend.calls.slice(before).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
  }finally{await removeOwnedBase(base);}
});
test("an occupied controlled month stops before any new upload or metadata change",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    const bytes=Buffer.from("existing fixture bytes"),owner=backend.users.find(u=>u.name==="MCP User A")??backend.keys.find(k=>k.name==="a")!.owner;
    model.assets.push({id:randomUUID(),owner,filename:"existing.png",bytes,checksum:createHash("sha1").update(bytes).digest("base64"),favorite:false,tags:new Set(),date:"2023-07-12T00:00:00.000Z"});
    await assert.rejects(createDiscoveryFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.cases.at(-1).id,"preflight_empty_a");assert.equal(saved.cases.at(-1).state,"failed");
    assert.equal(model.assets.length,1);assert.ok(backend.calls.every(c=>c.path!=="/api/assets"&&!(c.method==="PUT"&&c.path.startsWith("/api/assets/"))));
  }finally{await removeOwnedBase(base);}
});
test("HTTP 200 cannot conceal mixed-OR leaks, wrong pagination, misaligned columns, altered markers or foreign folder assets",{concurrency:2},async t=>{
  const faults=[["leakMixedOr","mixed_or_b"],["badLegacyCursor","legacy_page_1_a"],["misalignBucket","enabled_partner_bucket_b"],
    ["badMarker","before_partner_map_b"],["foreignFolder","folder_a_0"]] as const;
  await Promise.all(faults.map(([fault,expected])=>t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createDiscoveryFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root),failed=saved.cases.find((c:any)=>c.state==="failed");assert.equal(failed?.id,expected);assert.equal(failed.diagnostic_code,"fixture_assertion");assert.equal(saved.state,"recovery_required");
      const count=backend.calls.length;await assert.rejects(createDiscoveryFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
      const report=JSON.parse(await readFile(join(root,DISCOVERY_PLAN+".report.json"),"utf8"));assert.equal(report.full_acceptance,false);assert.equal(report.fixture_state,"recovery_required");
    }finally{await removeOwnedBase(base);}
  })));
});
});
