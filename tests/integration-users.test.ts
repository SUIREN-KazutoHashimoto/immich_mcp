import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { fixtureServerId } from "../src/integration-bootstrap.js";
import { createUserFixtures,USER_PLAN } from "../src/integration-user-fixtures.js";
import { registry } from "../src/registry.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { userBackend } from "./user-harness.js";
const isCode=(code:string)=>(e:unknown)=>e instanceof BridgeError&&e.code===code;
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=await userBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedHarnessAccounts(root,backend.backend);return {base,root,runner,...backend};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),v=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return v.get("__integration_feature_runs",USER_PLAN,"fixture_run");}finally{v.close();}
}
async function files(path:string):Promise<Buffer[]>{
  const result:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const next=join(path,entry.name);
    if(entry.isDirectory())result.push(...await files(next));else if(entry.isFile())result.push(await readFile(next));}return result;
}
describe("profile, user configuration and administrative user scenarios",{concurrency:2},()=>{
test("native HTTP validates profile multipart and image readers, preferences restoration, all eleven admin user operations and both config visibility levels",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-user-native-")),root=join(base,"run"),{backend,model,http}=await userBackend(),errors:string[]=[];
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
    const beforePasswords=backend.users.map(u=>[u.id,u.password]);
    const result=await createUserFixtures(root,options).catch(async error=>{
      const saved=await journal(root),last=saved.cases.at(-1);t.diagnostic(JSON.stringify({case:last?.id,state:last?.state,status:last?.status,diagnostic:last?.diagnostic_code}));throw error;
    });
    const saved=await journal(root);t.diagnostic(JSON.stringify({initial_cases:saved.cases.length}));
    assert.equal(result.state,"user_fixtures_ready");assert.equal(result.execution_scope,"harness_only");assert.ok(saved.cases.length<256&&saved.cases.every((c:any)=>c.state==="passed"));
    assert.equal(model.profileUploads,3);assert.equal(model.extraCreates,1);assert.equal(backend.users.length,4);
    for(const [id,password] of beforePasswords)assert.equal(backend.users.find(u=>u.id===id)!.password,password);
    const expected=registry.operations.filter(o=>["Users (admin)","Config (user)","Config (public)"].includes(o.tag)).map(o=>o.operationId).sort();
    assert.equal(expected.length,15);
    assert.deepEqual([...new Set<string>(saved.cases.filter((c:any)=>c.kind==="success"&&expected.includes(c.operation_id)).map((c:any)=>c.operation_id))].sort(),expected);
    for(const op of registry.operations.filter(o=>o.tag==="Users (admin)")){
      assert.ok(saved.cases.some((c:any)=>c.operation_id===op.operationId&&c.actor==="a"&&c.status===403));
      assert.ok(saved.cases.some((c:any)=>c.operation_id===op.operationId&&c.actor==="restricted"&&c.status===403));
    }
    const a=backend.keys.find(k=>k.name==="a")!.owner.id,b=backend.keys.find(k=>k.name==="b")!.owner.id;
    const finalProfile=model.users.get(a)!;assert.ok(finalProfile.profileImagePath);assert.equal(model.users.get(b)!.profileImagePath,"");
    const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
    try{
      const page=await browser.newPage();await page.setContent('<img id="profile" src="data:image/jpeg;base64,'+finalProfile.profile!.toString("base64")+'">');
      assert.deepEqual(await page.locator("#profile").evaluate(async(image:any)=>{await image.decode();return [image.naturalWidth,image.naturalHeight];}),[64,32]);
    }finally{await browser.close();}
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);assert.equal(report.full_acceptance,false);
    assert.ok(report.operations.every((op:any)=>op.real_success_cases===0&&op.real_refusal_cases===0&&op.integration_success==="not_run"));
    const publicText=JSON.stringify(report),secrets=[...backend.keys.map(k=>k.secret),...backend.users.map(u=>u.password)];
    for(const secret of secrets)assert.ok(!publicText.includes(secret));
    for(const field of ["input","result_ref","secret_ref","file_ref","context_ref"])assert.ok(!publicText.includes('"'+field+'"'));
    for(const buffer of await files(root))for(const secret of secrets)assert.equal(buffer.includes(Buffer.from(secret)),false);
    const count=backend.calls.length,uploads=model.profileUploads,creates=model.extraCreates;
    assert.equal((await createUserFixtures(root,options)).state,"user_fixtures_revalidated");
    assert.ok(backend.calls.slice(count).every(c=>c.method==="GET"));assert.equal(model.profileUploads,uploads);assert.equal(model.extraCreates,creates);
    t.diagnostic(JSON.stringify({revalidation_cases:(await journal(root)).validation.cases.length}));
    finalProfile.profileImagePath="externally-changed.jpeg";const change=backend.calls.length;
    await assert.rejects(createUserFixtures(root,options),isCode("fixture_validation_failed"));assert.ok(backend.calls.slice(change).every(c=>c.method==="GET"));
    const failed=await journal(root);assert.equal(failed.state,"completed");assert.equal(failed.validation.state,"failed");assert.equal(failed.validation.cases.at(-1).id,"final_user_a");
    assert.deepEqual(errors,[]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(base,{recursive:true,force:true});}
});
test("lost user-creation acknowledgement preserves the new user and prevents account, image and preference replay",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.loseUserCreate=true;await assert.rejects(createUserFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root);assert.equal(saved.cases.at(-1).id,"create_extra_user");assert.equal(saved.cases.at(-1).state,"outcome_unknown");assert.equal(model.extraCreates,1);
    const count=backend.calls.length,uploads=model.profileUploads;model.loseUserCreate=false;
    await assert.rejects(createUserFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(model.extraCreates,1);assert.equal(model.profileUploads,uploads);
    assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
  }finally{await rm(base,{recursive:true,force:true});}
});
test("existing profile data fails the initial preflight before any upstream mutation",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.existingProfile=true;await assert.rejects(createUserFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.profileUploads,0);assert.equal(model.extraCreates,0);assert.ok(backend.calls.every(c=>c.method==="GET"));
    assert.equal((await journal(root)).cases.at(-1).id,"baseline_user_a");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("successful status codes cannot conceal corrupt images, missing preference or user writes, failed restore or incorrect public config",{concurrency:2},async t=>{
  const faults=[["profileCorrupt","first_profile_a_owner"],["preferencesNoPersist","rating_preference_readback"],["adminUpdateNoPersist","extra_update_readback"],["restoreNoEffect","restore_extra_readback"],["publicConfigWrong","final_public_user_config_a"]] as const;
  await Promise.all(faults.map(([fault,expected])=>t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createUserFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root);assert.equal(saved.cases.find((c:any)=>c.state==="failed").id,expected);assert.equal(saved.state,"recovery_required");
      const count=backend.calls.length;await assert.rejects(createUserFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
    }finally{await rm(base,{recursive:true,force:true});}
  })));
});
});
