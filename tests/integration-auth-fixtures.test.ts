import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { bootstrapLab,withInitializedFixtureLab,fixtureServerId } from "../src/integration-bootstrap.js";
import { AUTH_PLAN,createAuthFixtures } from "../src/integration-auth-fixtures.js";
import { IntegrationRun,type CaseSpec } from "../src/integration-run.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { integrationCommand } from "../scripts/integration.js";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { authBackend,seedAuthAccounts } from "./auth-harness.js";
const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const mutations=(calls:{method:string}[])=>calls.filter(c=>!["GET","HEAD"].includes(c.method)).length;
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",AUTH_PLAN,"fixture_run");}finally{v.close();}
}
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),model=authBackend();
  await upLab(root,{docker:runner,http:model.http});await seedAuthAccounts(root,model.backend);
  return {base,root,runner,...model};
}
async function plaintextFiles(path:string):Promise<Buffer[]>{
  const output:Buffer[]=[];
  for(const entry of await readdir(path,{withFileTypes:true})){
    const next=join(path,entry.name);if(entry.isDirectory())output.push(...await plaintextFiles(next));else if(entry.isFile())output.push(await readFile(next));
  }
  return output;
}

test("native HTTP authentication fixtures verify PIN, shared-link passwords/cookies and read-only repeats",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-auth-native-")),root=join(base,"run"),{backend,model,http}=authBackend(),errors:string[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const bytes=Buffer.concat(chunks),headers=new Headers(req.headers as Record<string,string>);
      const body=bytes.length?(headers.get("content-type")?.includes("application/json")?bytes.toString("utf8"):bytes):undefined;
      const response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers,body,redirect:"manual"} as any);
      res.statusCode=response.status;
      for(const [name,value]of response.headers)if(name!=="set-cookie")res.setHeader(name,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader("set-cookie",cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error instanceof Error?error.name:"unknown");res.writeHead(500);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root),options={docker:runner};
    await upLab(root,options);await bootstrapLab(root,options);
    const result=await createAuthFixtures(root,options).catch(async error=>{
      const failed=await journal(root),last=failed.cases.at(-1);
      t.diagnostic(JSON.stringify({case:last?.id,diagnostic:last?.diagnostic_code,status:last?.status,state:last?.state}));
      throw error;
    });assert.equal(result.state,"auth_fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    const initial=await journal(root),report=JSON.parse(await readFile(result.report,"utf8"));
    assert.equal(initial.state,"completed");assert.equal(initial.cases.length,60);assert.ok(initial.cases.every((c:any)=>c.state==="passed"));
    assert.equal(report.full_acceptance,false);assert.equal(report.completed_41_category_acceptance,false);assert.equal(report.operations.length,279);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0&&op.real_local_refusal_cases===0));
    assert.equal(initial.cases.filter((c:any)=>c.kind==="local_refusal").length,4);
    const publicText=JSON.stringify(report);
    for(const value of [initial.data.pin,...Object.values(initial.data.passwords),...Object.values(initial.data.links).map((l:any)=>l.key),initial.data.links.main.slug,
      ...Object.values(initial.data.contexts).map((c:any)=>c.ref)] as string[])assert.ok(!publicText.includes(value));
    const before=mutations(backend.calls),assets=model.assets.length,links=model.links.length;
    const again=await createAuthFixtures(root,options);assert.equal(again.state,"auth_fixtures_revalidated");
    const repeated=await journal(root);assert.equal(repeated.validation.cases.length,17);assert.equal(mutations(backend.calls),before);
    assert.equal(model.assets.length,assets);assert.equal(model.links.length,links);
    const files=await plaintextFiles(join(root,"fixtures"));
    for(const value of [initial.data.pin,...Object.values(initial.data.passwords),...backend.keys.map(k=>k.secret),...backend.sessions.keys()] as string[])
      assert.ok(files.every(bytes=>!bytes.includes(Buffer.from(value))));
    // A later upstream elevation breaks the final locked-state assertion without replaying setup.
    model.elevated.add([...backend.sessions].find(([,user])=>user.id===backend.users.find(u=>u.name=== "User A"||u.name==="A")?.id)?.[0]??"unused");
    const actorA=backend.users.find(u=>model.pins.has(u.id))!,sessionA=[...backend.sessions].find(([,u])=>u.id===actorA.id)![0];model.elevated.add(sessionA);
    const count=mutations(backend.calls);
    await assert.rejects(createAuthFixtures(root,options),isCode("fixture_validation_failed"));assert.equal(mutations(backend.calls),count);
    const failed=await journal(root);assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");
    assert.deepEqual(errors,[]);t.diagnostic("60 initial cases and 17 read-only revalidation cases");
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(base,{recursive:true,force:true});
  }
});

test("a lost PIN unlock acknowledgement durably fences all subsequent fixture mutations",async()=>{
  const {base,root,runner,backend,model,http}=await environment();model.loseUnlock=true;
  try{
    await assert.rejects(createAuthFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),last=saved.cases.at(-1);
    assert.equal(saved.state,"recovery_required");assert.equal(last.id,"explicit_session_unlock");assert.equal(last.state,"outcome_unknown");
    assert.equal(model.elevated.size,1);
    const count=mutations(backend.calls);
    await assert.rejects(createAuthFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(mutations(backend.calls),count);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a 204 unlock without elevation fails the following semantic assertion",async()=>{
  const {base,root,runner,model,http}=await environment();model.fakeUnlock=true;
  try{
    await assert.rejects(createAuthFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.state,"recovery_required");assert.equal(saved.cases.at(-1).id,"session_elevated");
    assert.equal(saved.cases.at(-1).status,200);assert.equal(saved.cases.at(-1).state,"failed");
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a backend that accepts another context's password cookie fails the isolation case",async()=>{
  const {base,root,runner,model,http}=await environment();model.cookieLeak=true;
  try{
    await assert.rejects(createAuthFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.state,"recovery_required");assert.equal(saved.cases.at(-1).id,"slug_context_has_no_key_cookie");
    assert.equal(saved.cases.at(-1).status,200);assert.equal(saved.cases.at(-1).state,"failed");
  }finally{await rm(base,{recursive:true,force:true});}
});

test("journal revalidation pins context selection and never labels a dispatched request as a local refusal",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async context=>{
      const run=new IntegrationRun(context,"context_journal_v1"),p=context.actors.a.principal,c=await run.contexts.register(p,{kind:"public",acknowledge:true});
      const selection={ref:c.context_ref,generation:c.generation},spec:CaseSpec={id:"version",actor:"a",call:{operation_id:"getServerVersion"},kind:"success",status:200,mutates:false,assertions:["version"],context:selection};
      const verify=(result:any,check:(value:unknown,id:string)=>void)=>check(result.data.patch===5,"version");
      await run.execute(spec,verify);run.finish();
      const repeated=new IntegrationRun(context,"context_journal_v1"),count=backend.calls.length;
      await assert.rejects(repeated.execute({...spec,context:undefined},verify),isCode("fixture_replay"));
      await assert.rejects(repeated.execute({...spec,context:{...selection,generation:2}},verify),isCode("fixture_replay"));assert.equal(backend.calls.length,count);
      await repeated.execute(spec,verify);repeated.finish();
      const localRun=new IntegrationRun(context,"false_local_refusal_v1");
      await assert.rejects(localRun.execute({...spec,id:"actually_sent",kind:"local_refusal",status:null,expected_error:"context_purpose"},()=>{}),isCode("fixture_observation"));
      assert.equal(localRun.state.cases[0]!.state,"failed");assert.ok(localRun.state.cases[0]!.sent_at);
      assert.equal(localRun.report().operations.find(op=>op.operation_id==="getServerVersion")!.harness_local_refusal_cases,0);
      assert.ok(!JSON.stringify(run.report()).includes(c.context_ref));
    },{docker:runner,http});
    await assert.rejects(integrationCommand(["auth-fixtures","--directory",root,"--port","22835"]),isCode("usage"));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("protected PIN inputs stay bound to the principal, context and generation before dispatch",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async context=>{
      const run=new IntegrationRun(context,"context_inputs_v1"),a=context.actors.a.principal,b=context.actors.b.principal;
      const ac=await run.contexts.register(a,{kind:"session",credential:context.vault.get(a,"actor","fixture_actor").session,acknowledge:true});
      const bc=await run.contexts.register(b,{kind:"session",credential:context.vault.get(b,"actor","fixture_actor").session,acknowledge:true});
      const input=run.protect("a",{operation_id:"unlockAuthSession",body:{}},{"/pinCode":"123456"},{ref:ac.context_ref,generation:ac.generation});
      const changed=run.contexts.setSessionMode(a,ac.context_ref,ac.generation,true,true),count=backend.calls.length;
      const cases:CaseSpec[]=[
        {id:"other_principal",actor:"b",call:input,context:{ref:bc.context_ref,generation:bc.generation},expected_error:"invalid_reference",kind:"local_refusal",status:null,mutates:true,assertions:["before_send"]},
        {id:"normal_route",actor:"a",call:input,expected_error:"invalid_reference",kind:"local_refusal",status:null,mutates:true,assertions:["before_send"]},
        {id:"changed_generation",actor:"a",call:input,context:{ref:changed.context_ref,generation:changed.generation},expected_error:"invalid_reference",kind:"local_refusal",status:null,mutates:true,assertions:["before_send"]},
        {id:"inline_pin",actor:"a",call:{operation_id:"unlockAuthSession",body:{pinCode:"123456"}},context:{ref:changed.context_ref,generation:changed.generation},expected_error:"secret_reference_required",kind:"local_refusal",status:null,mutates:true,assertions:["before_send"]},
      ];
      for(const spec of cases)await run.execute(spec,(_result,check)=>check(true,"before_send"));
      assert.equal(backend.calls.length,count);assert.ok(run.state.cases.every(c=>c.state==="passed"&&!c.sent_at));run.finish();
      assert.throws(()=>run.protect("a",{operation_id:"setupPinCode"},{"/pinCode":"123456"}),isCode("fixture_replay"));
      assert.ok(!JSON.stringify(run.report()).includes("123456"));
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});

test("the scenario journal accepts corrected 302/307 transports while keeping redirect credentials private",async()=>{
  const {base,root,runner,http}=await environment();
  const canary="https://redirect.invalid/?code=REDIRECT-CREDENTIAL-CANARY",observed:string[]=[];
  const transport=(async(input:any,init:any)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith("/thumbnail")||path==="/api/oauth/mobile-redirect"){
      assert.equal(init.redirect,"manual");assert.ok(new Headers(init.headers).get("x-api-key"));
      observed.push(path);return new Response(null,{status:path.endsWith("/thumbnail")?302:307,headers:{location:canary}});
    }
    return http(input,init);
  }) as typeof fetch;
  try{
    await withInitializedFixtureLab(root,async context=>{
      const run=new IntegrationRun(context,"redirect_contracts_v1");
      for(const [id,status,call] of [
        ["thumbnail",302,{operation_id:"viewAsset",path:{id:"00000000-0000-4000-8000-000000000001"}}],
        ["mobile",307,{operation_id:"redirectOAuthToMobile"}],
      ] as const){
        await run.execute({id,actor:"a",call,status,kind:"success",mutates:false,assertions:["exact_status","private_location"]},(result,check)=>{
          check(result.upstream.status===status,"exact_status");
          check(!JSON.stringify(result).includes("REDIRECT-CREDENTIAL-CANARY"),"private_location");
          const stored=context.vault.get(context.actors.a.principal,result.result_ref,"result");
          assert.equal(context.vault.get(context.actors.a.principal,stored.transport_secret_ref,"transport_secret").location,canary);
        });
      }
      run.finish();assert.equal(observed.length,2);assert.ok(!JSON.stringify(run.report()).includes(canary));
    },{docker:runner,http:transport});
  }finally{await rm(base,{recursive:true,force:true});}
});
