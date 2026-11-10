import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { fixtureServerId } from "../src/integration-bootstrap.js";
import { createCollectionFixtures,COLLECTION_PLAN } from "../src/integration-collection-fixtures.js";
import { registry } from "../src/registry.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { collectionBackend } from "./collection-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=collectionBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedHarnessAccounts(root,backend.backend);return {base,root,runner,...backend};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",COLLECTION_PLAN,"fixture_run");}finally{v.close();}
}
async function files(path:string):Promise<Buffer[]>{
  const contents:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){
    const next=join(path,entry.name);if(entry.isDirectory())contents.push(...await files(next));else if(entry.isFile())contents.push(await readFile(next));
  }return contents;
}
describe("memory and stack collection scenarios",{concurrency:2},()=>{
test("native HTTP verifies all fifteen memory/stack operations, exact membership and owner isolation, then repeats only read cases",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-collections-native-")),root=join(base,"run"),{backend,model,http}=collectionBackend(),errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("test request bound");chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks),headers=new Headers(req.headers as Record<string,string>),
        body=bytes.length?(headers.get("content-type")?.includes("application/json")?bytes.toString("utf8"):bytes):undefined;
      const response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers,body,redirect:"manual"} as any);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error instanceof Error?error.name:"unknown");if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root),options={docker:runner};
    await upLab(root,options);await seedHarnessAccounts(root,backend);
    const result=await createCollectionFixtures(root,options).catch(async error=>{
      const saved=await journal(root),last=saved.cases.at(-1);t.diagnostic(JSON.stringify({case:last?.id,state:last?.state,status:last?.status,diagnostic:last?.diagnostic_code}));throw error;
    });
    assert.equal(result.state,"collection_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    const saved=await journal(root);assert.equal(saved.cases.length,109);assert.ok(saved.cases.every((c:any)=>c.state==="passed"));
    assert.equal(model.assets.length,6);assert.equal(model.memories.length,2);assert.equal(model.stacks.length,2);
    const expected=registry.operations.filter(o=>["Memories","Stacks"].includes(o.tag)).map(o=>o.operationId).sort();
    const observed=[...new Set<string>(saved.cases.filter((c:any)=>expected.includes(c.operation_id)&&c.kind==="success").map((c:any)=>c.operation_id))].sort();
    assert.equal(expected.length,15);assert.deepEqual(observed,expected);
    for(const id of expected){
      assert.ok(saved.cases.some((c:any)=>c.operation_id===id&&c.actor==="restricted"&&c.status===403));
    }
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.equal(report.full_acceptance,false);assert.equal(report.api_integration_completed,false);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0&&op.integration_success==="not_run"));
    const publicText=JSON.stringify(report),secrets=[...backend.keys.map(k=>k.secret),...backend.users.map(u=>u.password)];
    for(const secret of secrets)assert.equal(publicText.includes(secret),false);
    for(const field of ["file_ref","result_ref","secret_ref","context_ref","input"])assert.equal(publicText.includes('"'+field+'"'),false);
    const persisted=await files(root);for(const content of persisted)for(const secret of secrets)assert.equal(content.includes(Buffer.from(secret)),false);
    const start=backend.calls.length;const repeated=await createCollectionFixtures(root,options);
    assert.equal(repeated.state,"collection_fixtures_revalidated");assert.ok(backend.calls.slice(start).every(c=>c.method==="GET"));
    const history=await journal(root);assert.equal(history.validation.cases.length,37);assert.ok(history.validation.cases.every((c:any)=>!c.mutates&&c.state==="passed"));
    model.memories.find(m=>m.id===saved.data.memories.a.id).isSaved=false;const count=backend.calls.length;
    await assert.rejects(createCollectionFixtures(root,options),isCode("fixture_validation_failed"));
    assert.ok(backend.calls.slice(count).every(c=>c.method==="GET"));
    const failed=await journal(root);assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");
    assert.equal(failed.validation.cases.at(-1).id,"final_memory_a");assert.equal(errors.length,0,errors.join(","));
  }finally{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));await rm(base,{recursive:true,force:true});}
});
test("a committed stack merge with a lost response is never recreated after restart",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.loseMerge=true;await assert.rejects(createCollectionFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),last=saved.cases.at(-1);assert.equal(last.id,"merge_stack");assert.equal(last.state,"outcome_unknown");
    assert.equal(model.assets.length,6);assert.equal(model.stacks.length,2);assert.ok(model.stacks.every(s=>s.id!==saved.data.stacks.initial));
    const before=backend.calls.length,ids=model.stacks.map(s=>s.id);model.loseMerge=false;
    await assert.rejects(createCollectionFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.deepEqual(model.stacks.map(s=>s.id),ids);assert.equal(model.assets.length,6);
    assert.ok(backend.calls.slice(before).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
  }finally{await rm(base,{recursive:true,force:true});}
});
test("successful HTTP responses cannot conceal missing writes, lost children, partial deletions or foreign search rows",{concurrency:2},async t=>{
  const faults=[
    ["memoryAddNoEffect","memory_added_readback"],["omitMergeChild","merge_stack"],["partialBulkDelete","bulk_deleted_readback_1"],
    ["leakSearch","final_memory_search_a"],["primaryNoEffect","stack_change_primary"]
  ] as const;
  await Promise.all(faults.map(([fault,expected])=>t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createCollectionFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root),failed=saved.cases.find((c:any)=>c.state==="failed");
      assert.equal(failed.id,expected);assert.equal(saved.state,"recovery_required");
      const count=backend.calls.length;await assert.rejects(createCollectionFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
      const report=JSON.parse(await readFile(join(root,COLLECTION_PLAN+".report.json"),"utf8"));
      assert.equal(report.full_acceptance,false);assert.equal(report.fixture_state,"recovery_required");
    }finally{await rm(base,{recursive:true,force:true});}
  })));
});
});
