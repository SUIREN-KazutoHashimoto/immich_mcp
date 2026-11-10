import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { fixtureServerId } from "../src/integration-bootstrap.js";
import { createSharingFixtures,SHARING_PLAN } from "../src/integration-sharing-fixtures.js";
import { registry } from "../src/registry.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { sharingBackend } from "./sharing-harness.js";
const isCode=(code:string)=>(e:unknown)=>e instanceof BridgeError&&e.code===code;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=sharingBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedHarnessAccounts(root,backend.backend);return {base,root,runner,...backend};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",SHARING_PLAN,"fixture_run");}finally{v.close();}
}
async function files(path:string):Promise<Buffer[]>{
  const result:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const next=join(path,entry.name);
    if(entry.isDirectory())result.push(...await files(next));else if(entry.isFile())result.push(await readFile(next));
  }return result;
}
describe("activity, directional partner and archive scenarios",{concurrency:2},()=>{
test("native HTTP sharing fixtures verify all eleven operations, ZIP originals and complete partner revocation, then repeat only reads",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-sharing-native-")),root=join(base,"run"),{backend,model,http}=sharingBackend(),errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("request bound");chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks),headers=new Headers(req.headers as Record<string,string>),body=bytes.length?(headers.get("content-type")?.includes("application/json")?bytes.toString("utf8"):bytes):undefined;
      const response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers,body,redirect:"manual"} as any);
      res.writeHead(response.status,Object.fromEntries(response.headers));const data=Buffer.from(await response.arrayBuffer());
      for(let i=0;i<data.length;i+=31)if(!res.write(data.subarray(i,i+31)))await once(res,"drain");res.end();
    }catch(e){errors.push((e as Error).name);if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root),options={docker:runner};
    await upLab(root,options);await seedHarnessAccounts(root,backend);
    const result=await createSharingFixtures(root,options).catch(async error=>{
      const saved=await journal(root),last=saved.cases.at(-1);t.diagnostic(JSON.stringify({case:last?.id,state:last?.state,status:last?.status,diagnostic:last?.diagnostic_code}));throw error;
    });
    const saved=await journal(root);assert.equal(result.state,"sharing_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    assert.equal(saved.cases.length,105);assert.ok(saved.cases.every((c:any)=>c.state==="passed"));
    assert.equal(model.assets.length,4);assert.equal(model.activities.length,2);assert.equal(model.partners.length,0);assert.equal(model.archives,4);
    const expected=registry.operations.filter(o=>["Activities","Partners","Download"].includes(o.tag)).map(o=>o.operationId).sort();
    assert.equal(expected.length,11);
    assert.deepEqual([...new Set<string>(saved.cases.filter((c:any)=>c.kind==="success"&&expected.includes(c.operation_id)).map((c:any)=>c.operation_id))].sort(),expected);
    for(const operation of expected)assert.ok(saved.cases.some((c:any)=>c.operation_id===operation&&c.actor==="restricted"&&c.status===403));
    const duplicate=saved.cases.find((c:any)=>c.id==="duplicate_asset_like");assert.equal(duplicate.status,200);
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.equal(report.full_acceptance,false);assert.equal(report.api_integration_completed,false);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0&&op.integration_success==="not_run"));
    const publicText=JSON.stringify(report),secrets=[...backend.keys.map(k=>k.secret),...backend.users.map(u=>u.password)];
    for(const secret of secrets)assert.ok(!publicText.includes(secret));
    for(const field of ["input","result_ref","secret_ref","file_ref","context_ref"])assert.ok(!publicText.includes('"'+field+'"'));
    for(const buffer of await files(root))for(const secret of secrets)assert.equal(buffer.includes(Buffer.from(secret)),false);
    const before=backend.calls.length,archives=model.archives;
    assert.equal((await createSharingFixtures(root,options)).state,"sharing_fixtures_revalidated");
    assert.ok(backend.calls.slice(before).every(c=>c.method==="GET"));assert.equal(model.archives,archives);
    assert.equal((await journal(root)).validation.cases.length,30);
    const a=backend.keys.find(k=>k.name==="a")!.owner,b=backend.keys.find(k=>k.name==="b")!.owner;model.partners.push({from:a,to:b,inTimeline:false});
    const count=backend.calls.length;await assert.rejects(createSharingFixtures(root,options),isCode("fixture_validation_failed"));
    assert.ok(backend.calls.slice(count).every(c=>c.method==="GET"));const failed=await journal(root);
    assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");assert.equal(failed.validation.cases.at(-1).id,"final_a_shared_by");
    assert.deepEqual(errors,[]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(base,{recursive:true,force:true});}
});
test("a lost partner-creation acknowledgement persists the relationship and fences all re-creation and archive generation",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.losePartner=true;await assert.rejects(createSharingFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.cases.at(-1).id,"create_partner_a_to_b");assert.equal(saved.cases.at(-1).state,"outcome_unknown");assert.equal(model.partners.length,1);
    const count=backend.calls.length,archives=model.archives;model.losePartner=false;
    await assert.rejects(createSharingFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.partners.length,1);assert.equal(model.archives,archives);
    assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
  }finally{await rm(base,{recursive:true,force:true});}
});
test("duplicate counts, reversed sharing, ineffective removal and corrupt ZIP data cannot become successful acceptance",{concurrency:2},async t=>{
  const faults=[["duplicateAddsRow","activities_before_delete"],["partnerWrongDirection","outgoing_partner_a"],["removeNoEffect","reverse_access_revoked"],["corruptZip","owner_archive"]] as const;
  await Promise.all(faults.map(([fault,expected])=>t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createSharingFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root),failed=saved.cases.find((c:any)=>c.state==="failed");assert.equal(failed.id,expected);
      assert.equal(saved.state,"recovery_required");const count=backend.calls.length;
      await assert.rejects(createSharingFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
      const report=JSON.parse(await readFile(join(root,SHARING_PLAN+".report.json"),"utf8"));assert.equal(report.full_acceptance,false);
    }finally{await rm(base,{recursive:true,force:true});}
  })));
});
});
