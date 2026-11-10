import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { withInitializedFixtureLab,fixtureServerId,fixturePrincipal } from "../src/integration-bootstrap.js";
import { createSyncFixtures,SYNC_PLAN } from "../src/integration-sync-fixtures.js";
import { completeSyncRows } from "../src/integration-sync-results.js";
import { IntegrationRun,type CaseSpec } from "../src/integration-run.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedAuthAccounts } from "./auth-harness.js";
import { syncBackend } from "./sync-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=syncBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedAuthAccounts(root,backend.backend);return {base,root,runner,...backend};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",SYNC_PLAN,"fixture_run");}finally{v.close();}
}
async function files(path:string):Promise<Buffer[]>{
  const result:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){
    const next=join(path,entry.name);if(entry.isDirectory())result.push(...await files(next));else if(entry.isFile())result.push(await readFile(next));
  }return result;
}
describe("session-bound synchronization scenarios",{concurrency:2},()=>{
test("native HTTP sync fixtures verify paged snapshots, isolated child checkpoints, deltas and all reset paths, then repeat only reads",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-sync-native-")),root=join(base,"run"),{backend,model,http}=syncBackend(),errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("test request bound");chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks),headers=new Headers(req.headers as Record<string,string>),
        body=bytes.length?(headers.get("content-type")?.includes("application/json")?bytes.toString("utf8"):bytes):undefined;
      const response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers,body,redirect:"manual"} as any);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)for await(const chunk of response.body as any){if(!res.write(Buffer.from(chunk)))await once(res,"drain");}
      res.end();
    }catch(error){errors.push(error instanceof Error?error.name:"unknown");if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root),options={docker:runner};
    await upLab(root,options);await seedAuthAccounts(root,backend);
    const result=await createSyncFixtures(root,options).catch(async error=>{
      const saved=await journal(root),last=saved.cases.at(-1);t.diagnostic(JSON.stringify({case:last?.id,state:last?.state,status:last?.status,diagnostic:last?.diagnostic_code}));throw error;
    });
    assert.equal(result.state,"sync_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    const saved=await journal(root);assert.equal(saved.cases.length,72);assert.ok(saved.cases.every((c:any)=>c.state==="passed"));
    assert.equal(model.childCreates,3);assert.equal(model.assets.length,2);
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.equal(report.full_acceptance,false);assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0));
    const streamed=saved.cases.filter((c:any)=>c.operation_id==="getSyncStream"&&c.kind==="success");assert.equal(streamed.length,9);
    assert.ok(streamed.every((c:any)=>c.mutates&&c.result_view==="complete_jsonl"));
    const scope=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(scope));key.fill(0);
    try{
      const first=streamed.find((c:any)=>c.id==="initial_stream_a"),result=v.get(fixturePrincipal(scope.id,"a"),first.result_ref,"result");
      assert.equal(result.display.truncated,true);assert.ok(result.projection.total_records>16);assert.equal(result.projection.complete,true);
    }finally{v.close();}
    const publicText=JSON.stringify(report),secrets=[...backend.keys.map(k=>k.secret),...backend.sessions.keys(),...backend.users.map(u=>"SYNC-PIN-CANARY-"+u.id)];
    for(const secret of secrets)assert.ok(!publicText.includes(secret));
    for(const c of Object.values<any>(saved.data.contexts))assert.ok(!publicText.includes(c.ref));
    const persisted=await files(root);for(const content of persisted)for(const secret of secrets)assert.equal(content.includes(Buffer.from(secret)),false);
    const before=backend.calls.length,streams=model.streamCalls,created=model.childCreates;
    const repeated=await createSyncFixtures(root,options);assert.equal(repeated.state,"sync_fixtures_revalidated");
    assert.ok(backend.calls.slice(before).every(c=>c.method==="GET"&&!c.path.endsWith("/sync/stream")));
    assert.equal(model.streamCalls,streams);assert.equal(model.childCreates,created);assert.equal((await journal(root)).validation.cases.length,11);
    model.checkpoints.clear();const start=backend.calls.length;
    await assert.rejects(createSyncFixtures(root,options),isCode("fixture_validation_failed"));
    assert.ok(backend.calls.slice(start).every(c=>c.method==="GET"));const history=await journal(root);
    assert.equal(history.state,"completed");assert.equal(history.validation.state,"failed");assert.equal(errors.length,0,errors.join(","));
  }finally{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));await rm(base,{recursive:true,force:true});}
});
test("an acknowledgement committed before response loss fences every child-session, stream and ack mutation on restart",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.loseAck=true;await assert.rejects(createSyncFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),last=saved.cases.at(-1);assert.equal(last.id,"store_initial_a");assert.equal(last.state,"outcome_unknown");
    assert.equal(model.childCreates,3);assert.ok([...model.checkpoints.values()].some(value=>value.size>0));
    const count=backend.calls.length,streams=model.streamCalls;model.loseAck=false;
    await assert.rejects(createSyncFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.childCreates,3);assert.equal(model.streamCalls,streams);
    assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
  }finally{await rm(base,{recursive:true,force:true});}
});
test("owner-scoped checkpoints, ineffective ack writes and foreign asset rows fail at their semantic assertions",async t=>{
  for(const fault of ["ownerScopedAcks","ackNoEffect","streamLeak"] as const)await t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createSyncFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root),failed=saved.cases.find((c:any)=>c.state==="failed");
      assert.equal(failed.id,fault==="ownerScopedAcks"?"same_owner_other_child_empty":fault==="ackNoEffect"?"saved_initial_a":"initial_stream_a");
      const count=backend.calls.length;await assert.rejects(createSyncFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
    }finally{await rm(base,{recursive:true,force:true});}
  });
});
test("paged sync acceptance is explicit and limited to complete JSONL, without relaxing existing fixture or revalidation guards",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    const response=(actorId:string)=>new Response(Array.from({length:20},(_,i)=>JSON.stringify({type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),id:actorId,pinCode:null},ack:"AuthUserV2|"+i})+"\n")
      .join("")+JSON.stringify({type:"SyncCompleteV1",data:{},ack:"SyncCompleteV1|now"})+"\n",{headers:{"content-type":"application/jsonlines+json"}});
    let streamRequests=0;
    const api=(async(input:any,init:any)=>{if(new URL(String(input)).pathname!=="/api/sync/stream")return http(input,init);streamRequests++;return response(backend.keys.find(k=>k.name==="a")!.owner.id);}) as typeof fetch;
    await withInitializedFixtureLab(root,async context=>{
      const call={operation_id:"getSyncStream",body:{types:["AuthUsersV2"]}},baseSpec:CaseSpec={id:"paged",actor:"a",call,status:200,kind:"success",mutates:true,assertions:["all_records"]};
      const strict=new IntegrationRun(context,"strict_sync_preview_v1");
      await assert.rejects(strict.execute(baseSpec,()=>{}),isCode("fixture_observation"));
      const complete=new IntegrationRun(context,"complete_sync_preview_v1");
      const spec={...baseSpec,result_view:"complete_jsonl" as const};
      await complete.execute(spec,async(result,check)=>{const rows=await completeSyncRows(complete,"a",result);check(result.truncated===true&&rows.length===21,"all_records");});
      const count=backend.calls.length,streams=streamRequests;assert.equal(streams,2);
      await assert.rejects(complete.execute({...spec,id:"wrong_operation",call:{operation_id:"getServerVersion"}},()=>{}),isCode("fixture_case"));
      assert.equal(backend.calls.length,count);assert.equal(streamRequests,streams);complete.finish();
      const revalidate=new IntegrationRun(context,"complete_sync_preview_v1");
      await assert.rejects(revalidate.execute({...spec,mutates:false},()=>{}),isCode("fixture_replay"));assert.equal(backend.calls.length,count);assert.equal(streamRequests,streams);
    },{docker:runner,http:api});
  }finally{await rm(base,{recursive:true,force:true});}
});
test("missing stream terminals and interrupted bodies cannot use the complete JSONL exception",async t=>{
  for(const interrupted of [false,true])await t.test(interrupted?"interrupted":"missing terminal",async()=>{
    const {base,root,runner,backend,http}=await environment();
    try{
      const api=(async(input:any,init:any)=>{
        if(new URL(String(input)).pathname!=="/api/sync/stream")return http(input,init);
        const bytes=Buffer.from(JSON.stringify({type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),pinCode:null},ack:"AuthUserV2|1"})+"\n");
        return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(bytes));if(interrupted)controller.error(Error("synthetic interruption"));else controller.close();}}),{headers:{"content-type":"application/jsonlines+json"}});
      }) as typeof fetch;
      await withInitializedFixtureLab(root,async context=>{
        const run=new IntegrationRun(context,"incomplete_sync_"+(interrupted?"interrupted":"unterminated"));
        await assert.rejects(run.execute({id:"incomplete",actor:"a",call:{operation_id:"getSyncStream",body:{types:["AuthUsersV2"]}},status:200,kind:"success",
          mutates:true,result_view:"complete_jsonl",assertions:["must_not_pass"]},()=>assert.fail()),isCode(interrupted?"fixture_outcome_unknown":"fixture_observation"));
        assert.equal(run.state.cases[0]!.state,interrupted?"outcome_unknown":"failed");
      },{docker:runner,http:api});
    }finally{await rm(base,{recursive:true,force:true});}
  });
});
});
