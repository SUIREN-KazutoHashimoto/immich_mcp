import test from "node:test";
import assert from "node:assert/strict";
import { readFile,writeFile,readdir,rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { fixtureBackend } from "./bootstrap-harness.js";
import { upLab,downLab,withRunningLab } from "../src/integration-lab.js";
import { bootstrapLab,fixturePrincipal,fixtureServerId,FIXTURE_ROLES } from "../src/integration-bootstrap.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const control="__integration_fixture_bootstrap";
async function environment(){
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{backend,http}=fixtureBackend();
  await upLab(root,{docker:runner,http});return {base,root,fake,runner,backend,http};
}
async function fixtureVault(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key"));
  try{return new Vault(join(root,"fixtures"),key,fixtureServerId(s));}finally{key.fill(0);}
}
async function files(root:string):Promise<string[]>{
  const out:string[]=[];for(const item of await readdir(root,{withFileTypes:true})){const path=join(root,item.name);if(item.isDirectory())out.push(...await files(path));else out.push(path);}return out;
}
function posts(calls:{method:string}[]){return calls.filter(call=>call.method==="POST");}

test("bootstrap uses protected public setup, caller-only admin operations and each owner's session for exactly four API keys",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    const initialized=await bootstrapLab(root,{docker:runner,http});assert.equal(initialized.state,"initialized");assert.equal(initialized.execution_scope,"harness_only");
    assert.equal(initialized.synthetic_accounts,3);assert.equal(initialized.key_bindings,4);assert.equal(initialized.full_acceptance,false);
    assert.equal(backend.users.length,3);assert.equal(backend.keys.length,4);
    assert.equal(backend.users.filter(user=>user.isAdmin).length,1);assert.deepEqual(backend.keys.map(k=>k.permissions),[["all"],["all"],["all"],["asset.read"]]);
    assert.equal(backend.keys[3]!.owner.id,backend.keys[1]!.owner.id);assert.notEqual(backend.keys[1]!.owner.id,backend.keys[2]!.owner.id);
    for(const call of backend.calls.filter(c=>c.path==="/api/api-keys"&&c.method==="POST")){assert.ok(call.headers.get("authorization")?.startsWith("Bearer session-canary-"));assert.equal(call.headers.get("x-api-key"),null);}
    const adminKey=backend.keys.find(k=>k.owner.isAdmin)!.secret;
    for(const call of backend.calls.filter(c=>c.path==="/api/admin/users")){assert.equal(call.headers.get("x-api-key"),adminKey);assert.equal(call.headers.get("authorization"),null);}
    for(const call of backend.calls.filter(c=>c.path==="/api/api-keys/me")){assert.ok(call.headers.get("x-api-key"));assert.equal(call.headers.get("authorization"),null);}
    const s=await state(root),vault=await fixtureVault(root);
    try{
      const meta=vault.get(control,"bootstrap","fixture_bootstrap");assert.equal(meta.state,"completed");assert.ok(meta.steps.every((step:any)=>step.state==="completed"));
      for(const [index,role] of FIXTURE_ROLES.entries()){
        const principal=fixturePrincipal(s.id,role),binding=vault.credential(principal);assert.equal(binding.key,backend.keys[index]!.secret);assert.equal(binding.revision,1);
        assert.throws(()=>vault.get(fixturePrincipal(s.id,role==="a"?"b":"a"),vault.binding(principal)!.credential!,"credential"),isCode("invalid_reference"));
      }
      assert.equal(vault.get(fixturePrincipal(s.id,"restricted"),"actor","fixture_actor").password,undefined);
    }finally{vault.close();}
    const report=JSON.parse(await readFile(initialized.report,"utf8"));assert.equal(report.bootstrap_state,"completed");assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.ok(report.operations.every((op:any)=>op.integration_success==="not_run"&&op.feature_acceptance==="incomplete"));
    assert.equal(report.operations.find((op:any)=>op.operation_id==="createApiKey").setup_observations.length,4);
    assert.equal(report.credential_check.state,"passed");assert.ok(Number.isFinite(Date.parse(report.completed_at)));assert.equal(report.cloudflare,"not_run");assert.equal(report.chatgpt,"not_run");assert.equal(report.api_integration_completed,false);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("generated passwords, sessions, keys and private input never appear in plaintext reports or persisted fixture files",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    const result=await bootstrapLab(root,{docker:runner,http});
    const canaries=[...backend.users.map(x=>x.password),...backend.keys.map(x=>x.secret),...backend.sessions.keys()];
    for(const file of await files(join(root,"fixtures"))){
      const bytes=await readFile(file);for(const secret of canaries)assert.ok(!bytes.includes(Buffer.from(secret)),"plaintext secret in fixture store");
    }
    for(const file of [join(root,"bootstrap-report.json"),join(root,"run.json")]){
      const bytes=await readFile(file);for(const secret of canaries)assert.ok(!bytes.includes(Buffer.from(secret)),"plaintext secret in public setup metadata");
    }
    for(const secret of canaries)assert.ok(!JSON.stringify(result).includes(secret));
    const report=await readFile(join(root,"bootstrap-report.json"),"utf8");assert.ok(!report.includes("secret_ref"));assert.ok(!report.includes("session-canary"));assert.ok(!report.includes("example.invalid"));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a repeated completed bootstrap only revalidates the same four keys, preserving bindings and avoiding all setup mutations",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await bootstrapLab(root,{docker:runner,http});const mutationCount=posts(backend.calls).length;backend.calls.length=0;
    const result=await bootstrapLab(root,{docker:runner,http});assert.equal(result.state,"already_initialized");assert.equal(result.credential_check,"passed");
    assert.equal(posts(backend.calls).length,0);assert.equal(backend.calls.filter(c=>c.path==="/api/api-keys/me").length,4);assert.equal(backend.keys.length,4);assert.ok(mutationCount>0);
    const s=await state(root),vault=await fixtureVault(root);
    try{for(const role of FIXTURE_ROLES)assert.equal(vault.credential(fixturePrincipal(s.id,role)).revision,1);}finally{vault.close();}
  }finally{await rm(base,{recursive:true,force:true});}
});

test("an initialized backend is never adopted or changed; a failed freshness preflight can be checked again without mutation",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    backend.initialized=true;await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_not_fresh"));assert.equal(posts(backend.calls).length,0);
    const vault=await fixtureVault(root);try{assert.throws(()=>vault.get(control,"bootstrap","fixture_bootstrap"));}finally{vault.close();}
    backend.initialized=false;assert.equal((await bootstrapLab(root,{docker:runner,http})).state,"initialized");
  }finally{await rm(base,{recursive:true,force:true});}
});

test("lost key-creation response leaves encrypted recovery evidence and a durable no-replay fence",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    backend.failKeyResponse=true;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(backend.keys.length,1);assert.equal(backend.users.length,1);
    const vault=await fixtureVault(root);
    try{
      const meta=vault.get(control,"bootstrap","fixture_bootstrap");assert.equal(meta.state,"recovery_required");assert.equal(meta.steps.at(-1).state,"outcome_unknown");
      assert.ok(meta.steps.filter((step:any)=>step.operation_id==="login").every((step:any)=>step.result_ref));
    }finally{vault.close();}
    backend.failKeyResponse=false;backend.calls.length=0;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(posts(backend.calls).length,0);assert.equal(backend.keys.length,1);
    const report=await readFile(join(root,"bootstrap-report.json"),"utf8");assert.ok(!report.includes("hidden-canary"));assert.ok(!report.includes(backend.keys[0]!.secret));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("key validation refusal never falls back to a session or recreates the key",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    backend.keyProbeDenied=true;await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(backend.keys.length,1);
    const keyCalls=backend.calls.filter(c=>c.path==="/api/api-keys/me");assert.equal(keyCalls.length,1);assert.equal(keyCalls[0]!.headers.get("authorization"),null);
    const vault=await fixtureVault(root);
    try{const p=fixturePrincipal((await state(root)).id,"admin");assert.equal(vault.binding(p),undefined);assert.equal(vault.get(p,"initial_key","fixture_key").secret,backend.keys[0]!.secret);}finally{vault.close();}
    backend.keyProbeDenied=false;backend.calls.length=0;await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(posts(backend.calls).length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a schema-valid login for a different owner fails before creating any API key",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    backend.after=(path,value)=>path==="/api/auth/login"?{...value,userId:randomUUID()}:value;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(backend.keys.length,0);assert.equal(backend.users.length,1);
    const report=JSON.parse(await readFile(join(root,"bootstrap-report.json"),"utf8"));assert.equal(report.diagnostic_code,"fixture_owner");assert.equal(report.full_acceptance,false);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a different permission set in the key response fails without registering or weakening the requested restriction",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    backend.after=(path,value)=>path==="/api/api-keys"&&value.permissions?.includes("asset.read")?{...value,permissions:["all"],apiKey:{...value.apiKey,permissions:["all"]}}:value;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(backend.keys.length,4);
    const vault=await fixtureVault(root);try{assert.equal(vault.binding(fixturePrincipal((await state(root)).id,"restricted")),undefined);}finally{vault.close();}
  }finally{await rm(base,{recursive:true,force:true});}
});

test("changing or losing the fixture master key cannot initialize a new store or send new mutations",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await bootstrapLab(root,{docker:runner,http});backend.calls.length=0;const original=await readFile(join(root,".vault.key"));
    await writeFile(join(root,".vault.key"),Buffer.alloc(32));await assert.rejects(bootstrapLab(root,{docker:runner,http}));assert.equal(posts(backend.calls).length,0);
    await rm(join(root,".vault.key"));await assert.rejects(bootstrapLab(root,{docker:runner,http}));assert.equal(posts(backend.calls).length,0);
    await writeFile(join(root,".vault.key"),original);assert.equal((await bootstrapLab(root,{docker:runner,http})).state,"already_initialized");
  }finally{await rm(base,{recursive:true,force:true});}
});

test("completed setup revalidation refuses revoked keys without recreating accounts or using stored sessions",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await bootstrapLab(root,{docker:runner,http});backend.keyProbeDenied=true;backend.calls.length=0;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_response"));assert.equal(posts(backend.calls).length,0);
    assert.ok(backend.calls.filter(c=>c.path==="/api/api-keys/me").every(c=>!c.headers.has("authorization")));assert.equal(backend.keys.length,4);
    const report=JSON.parse(await readFile(join(root,"bootstrap-report.json"),"utf8"));assert.equal(report.bootstrap_state,"completed");assert.equal(report.credential_check.state,"failed");assert.equal(report.credential_check.actor,"admin");assert.equal(report.credential_check.status,401);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("running-lab callbacks retain exclusive ownership and harness provenance remains sticky",async()=>{
  const {base,root,runner,fake,http}=await environment();let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const task=withRunningLab(root,async lab=>{assert.equal(lab.observation.execution_scope,"harness_only");entered();await held;return "done";},{docker:runner,http});
  try{
    await started;fake.calls.length=0;await assert.rejects(downLab(root,false,{docker:runner}));assert.equal(fake.calls.length,0);
    assert.equal((await state(root)).harness_used,true);release();assert.equal(await task,"done");
  }finally{release();await task.catch(()=>{});await rm(base,{recursive:true,force:true});}
});

test("actual process death during a sent setup request preserves the no-replay fence after reopening SQLite",async()=>{
  const {base,root,runner,backend,http}=await environment();
  const bootstrap=pathToFileURL(join(process.cwd(),"dist/src/integration-bootstrap.js")).href;
  const lab=pathToFileURL(join(process.cwd(),"dist/src/integration-lab.js")).href;
  const harness=pathToFileURL(join(process.cwd(),"dist/tests/lab-harness.js")).href;
  const upstream=pathToFileURL(join(process.cwd(),"dist/tests/bootstrap-harness.js")).href;
  const source='import {bootstrapLab} from '+JSON.stringify(bootstrap)+';import {upLab} from '+JSON.stringify(lab)+';import {fakeDocker} from '+JSON.stringify(harness)+';import {fixtureBackend} from '+JSON.stringify(upstream)+';'+
    'const root='+JSON.stringify(root)+';const {runner}=fakeDocker(root);const {backend,http}=fixtureBackend();await upLab(root,{docker:runner,http});'+
    'backend.before=async path=>{if(path==="/api/auth/admin-sign-up"){setInterval(()=>{},1000);process.stdout.write("paused\\n");await new Promise(()=>{});}};await bootstrapLab(root,{docker:runner,http});';
  const worker=spawn(process.execPath,["--input-type=module","--eval",source],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";worker.stdout!.on("data",chunk=>{stdout+=chunk.toString();});worker.stderr!.on("data",chunk=>{stderr+=chunk.toString();});
  const closed=new Promise<void>((accept,reject)=>{worker.once("error",reject);worker.once("close",()=>accept());});
  try{
    await new Promise<void>((accept,reject)=>{
      const timer=setTimeout(()=>reject(Error("setup child did not pause: "+stderr)),45000);
      const check=()=>{if(stdout.includes("paused\n")){clearTimeout(timer);accept();}};
      worker.stdout!.on("data",check);worker.once("close",()=>{clearTimeout(timer);if(!stdout.includes("paused\n"))reject(Error("setup child exited: "+stderr));});check();
    });
    worker.kill("SIGKILL");await closed;backend.calls.length=0;
    const vault=await fixtureVault(root);try{const meta=vault.get(control,"bootstrap","fixture_bootstrap");assert.equal(meta.state,"started");assert.equal(meta.steps.at(-1).state,"sent");}finally{vault.close();}
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(posts(backend.calls).length,0);
  }finally{worker.kill("SIGKILL");await closed.catch(()=>{});await rm(base,{recursive:true,force:true});}
});

test("completed setup rejects a caller binding replaced with another fixture owner's valid key",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await bootstrapLab(root,{docker:runner,http});const s=await state(root),vault=await fixtureVault(root);
    try{
      const principal=fixturePrincipal(s.id,"a"),other=vault.credential(fixturePrincipal(s.id,"b"));
      vault.replaceBinding(principal,other.key,other.keyId,vault.credential(principal).revision);
    }finally{vault.close();}
    backend.calls.length=0;
    await assert.rejects(bootstrapLab(root,{docker:runner,http}),isCode("fixture_key_identity"));
    assert.equal(posts(backend.calls).length,0);assert.equal(backend.keys.length,4);
    const report=JSON.parse(await readFile(join(root,"bootstrap-report.json"),"utf8"));
    assert.equal(report.credential_check.state,"failed");assert.equal(report.credential_check.actor,"a");assert.equal(report.credential_check.status,null);
  }finally{await rm(base,{recursive:true,force:true});}
});
