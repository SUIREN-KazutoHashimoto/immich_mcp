import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { mkdtemp,mkdir,readFile,writeFile,rm,stat,cp,symlink,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Application } from "../src/app.js";
import { runtimeIntegrity } from "../src/runtime-integrity.js";
import { registry } from "../src/registry.js";
const origin="https://mcp.example",version={major:3,minor:3,patch:5,prerelease:null};
async function fixture(run:(app:Application,root:string,key:Buffer,keyFile:string,hits:()=>number)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"immich-readiness-")),key=randomBytes(32),keyFile=join(root,"vault.key");await writeFile(keyFile,key);let hits=0;
  const app=await Application.create({directory:join(root,"data"),upstream:"http://immich/api",masterKey:key,masterKeyFile:keyFile,host:"127.0.0.1",port:3000,
    publicOrigin:origin,issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs"},
    {http:(async()=>{hits++;return Response.json(version);}) as typeof fetch,versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0});
  try{await run(app,root,key,keyFile,()=>hits);}finally{await app.close();await rm(root,{recursive:true,force:true});}
}
const ready=async(app:Application)=>{const response=await app.fetch(new Request(origin+"/health/ready"));return {status:response.status,body:await response.json()};};
test("readiness independently reports DB, schema, key, storage and registry without exposing identifiers or secrets",()=>fixture(async(app,root,key)=>{
  const first=await ready(app);assert.equal(first.status,200);assert.equal(first.body.ready,true);
  for(const name of ["database","migration","master_key","storage","registry"])assert.equal(first.body.checks[name],"ok");
  const identity=app.vault.get("__system","store_identity","store_identity").id,json=JSON.stringify(first.body);
  for(const hidden of [root,key.toString("hex"),identity,app.vault.keyVersion,"cloudflareaccess.com","immich/api"])assert.ok(!json.includes(hidden));
  const records=app.vault.db.prepare("SELECT principal,id,hex(payload) payload FROM records ORDER BY principal,id").all(),totals=app.vault.db.prepare("SELECT * FROM storage_global").all();
  await app.checkLocal(true);assert.deepEqual(app.vault.db.prepare("SELECT principal,id,hex(payload) payload FROM records ORDER BY principal,id").all(),records);
  assert.deepEqual(app.vault.db.prepare("SELECT * FROM storage_global").all(),totals);assert.ok(!(await readdir(app.vault.directory)).some(n=>n.startsWith(".readiness-")));
}));
test("a missing or changed key file fails readiness and prevents queued upstream sends until recovery",()=>fixture(async(app,_root,key,keyFile,hits)=>{
  app.vault.replaceBinding("A","API-CANARY","id",0);await writeFile(keyFile,randomBytes(32));await app.checkLocal(true);
  const bad=await ready(app);assert.equal(bad.status,503);assert.equal(bad.body.checks.master_key,"error");assert.equal(bad.body.version_state,"ok");
  const before=hits(),job=await app.jobs.submit("A",{operation_id:"getServerVersion"});await app.jobs.idle();
  assert.equal(app.jobs.get("A",job.job_ref).state,"failed");assert.equal(app.jobs.get("A",job.job_ref).send_started,false);assert.equal(hits(),before);
  await rm(keyFile);await app.checkLocal(true);assert.equal((await ready(app)).body.checks.master_key,"error");
  const live=await app.fetch(new Request(origin+"/health/live"));assert.equal(live.status,200);
  await writeFile(keyFile,key);await app.checkLocal(true);assert.equal((await ready(app)).status,200);await app.jobs.idle();assert.equal(hits(),before);
  const next=await app.jobs.submit("A",{operation_id:"getServerVersion"});await app.jobs.idle();assert.equal(app.jobs.get("A",next.job_ref).state,"completed");assert.equal(hits(),before+1);
}));
test("readiness detects query-only DBs, schema/header changes and authenticated key-check corruption, then recovers",()=>fixture(async(app)=>{
  const db=app.vault.db;
  const ledger=db.prepare("SELECT bytes FROM storage_global WHERE id=1").get()!.bytes;
  db.exec("DELETE FROM storage_global");await app.checkLocal(true);assert.equal((await ready(app)).body.checks.database,"error");
  db.prepare("INSERT INTO storage_global VALUES(1,?)").run(ledger!);
  db.exec("PRAGMA query_only=ON");await app.checkLocal(true);assert.equal((await ready(app)).body.checks.database,"error");db.exec("PRAGMA query_only=OFF");
  db.exec("UPDATE schema_version SET version=99");await app.checkLocal(true);assert.equal((await ready(app)).body.checks.migration,"error");db.exec("UPDATE schema_version SET version=2");
  const old=app.vault.keyVersion;db.prepare("UPDATE vault_crypto SET key_version=?").run(randomUUID());await app.checkLocal(true);assert.equal((await ready(app)).body.checks.migration,"error");db.prepare("UPDATE vault_crypto SET key_version=?").run(old);
  const check=Buffer.from((db.prepare("SELECT payload FROM records WHERE principal='__system' AND id='key_check'").get() as any).payload),bad=Buffer.from(check);bad[bad.length-1]=bad[bad.length-1]!^1;
  db.prepare("UPDATE records SET payload=? WHERE principal='__system' AND id='key_check'").run(bad);await app.checkLocal(true);assert.equal((await ready(app)).body.checks.master_key,"error");
  db.prepare("UPDATE records SET payload=? WHERE principal='__system' AND id='key_check'").run(check);await app.checkLocal(true);assert.equal((await ready(app)).status,200);
}));
test("readiness rejects a mismatched object owner or unavailable configured storage path without leaking paths",()=>fixture(async(app,root)=>{
  const original=app.vault.get("__system","store_identity","store_identity");app.vault.put("__system","store_identity",{id:randomUUID()},Number.MAX_SAFE_INTEGER,"store_identity");
  await app.checkLocal(true);assert.equal((await ready(app)).body.checks.storage,"error");app.vault.put("__system","store_identity",original,Number.MAX_SAFE_INTEGER,"store_identity");
  const directory=app.vault.directory,blocker=join(root,"not-a-directory");await writeFile(blocker,"block");
  Object.defineProperty(app.vault,"directory",{value:blocker,configurable:true});
  try{await app.checkLocal(true);const result=await ready(app);assert.equal(result.status,503);assert.equal(result.body.checks.storage,"error");assert.ok(!JSON.stringify(result.body).includes(blocker));}
  finally{Object.defineProperty(app.vault,"directory",{value:directory,configurable:true});}
  await app.checkLocal(true);assert.equal((await ready(app)).status,200);
}));
test("runtime asset checks detect changed/missing files and loaded registry mutation, and reject startup before creating data",async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-runtime-assets-"));
  const assets=["src/generated/registry.json","src/generated/upload-script.json","contracts/sync-records.v3.3.5.json","immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json","immich_mcp_spec_v3.3.5/contracts/mcp-tool-contracts.json"];
  try{
    for(const path of assets){const target=join(root,path);await mkdir(resolve(target,".."),{recursive:true});await cp(resolve(path),target);}
    const base=pathToFileURL(join(root,"src","runtime-integrity.ts"));assert.equal(await runtimeIntegrity(base),"ok");
    for(const path of assets){const file=join(root,path),original=await readFile(file);await writeFile(file,Buffer.concat([original,Buffer.from(" ")]));assert.equal(await runtimeIntegrity(base),"error");await writeFile(file,original);}
    await rm(join(root,assets[0]!));assert.equal(await runtimeIntegrity(base),"error");
    const old=registry.operations[0]!.path;registry.operations[0]!.path="/tampered";
    try{assert.equal(await runtimeIntegrity(),"error");}finally{registry.operations[0]!.path=old;}
    const data=join(root,"unused-data");
    await assert.rejects(Application.create({directory:data,upstream:"http://immich/api",masterKey:randomBytes(32),host:"127.0.0.1",port:3000,publicOrigin:origin,
      issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs"},{runtimeIntegrity:async()=>"error"}),{code:"runtime_integrity"});
    await assert.rejects(stat(data),{code:"ENOENT"});
  }finally{await rm(root,{recursive:true,force:true});}
});
test("the built runtime verifies assets and serves readiness from a separate bundle without the source tree",async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-runtime-bundle-"));
  try{
    for(const folder of ["src","contracts","immich_mcp_spec_v3.3.5"])await cp(resolve("dist",folder),join(root,"dist",folder),{recursive:true});
    await writeFile(join(root,"package.json"),JSON.stringify({name:"immich-mcp",type:"module"}));await symlink(resolve("node_modules"),join(root,"node_modules"),"junction");
    const program='import{Application}from"./dist/src/app.js";import{randomBytes}from"node:crypto";const app=await Application.create({directory:"./data",upstream:"http://immich/api",masterKey:randomBytes(32),host:"127.0.0.1",port:3000,publicOrigin:"https://mcp.example",issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs"},{http:async()=>Response.json({major:3,minor:3,patch:5,prerelease:null}),versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0});console.log(await(await app.fetch(new Request("https://mcp.example/health/ready"))).text());await app.close();';
    const result=spawnSync(process.execPath,["--input-type=module","-e",program],{cwd:root,encoding:"utf8",timeout:30000});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ready,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
