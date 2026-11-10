import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes,randomUUID,createCipheriv,createHash } from "node:crypto";
import { mkdtemp,mkdir,readFile,writeFile,rm,unlink,readdir,copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Vault } from "../src/vault.js";
import { backupVault,restoreVault } from "../src/vault-backup.js";
import { hashFile,verifyGenerationManifest } from "../src/vault-manifest.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { Contexts } from "../src/contexts.js";
import { maintenanceServer } from "../scripts/vault.js";
const serverId="offline-backup-test",stream=(b:Uint8Array)=>(async function*(){yield b;})();
const resolver=()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}});
async function fixture(run:(root:string,key:Buffer)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"immich-offline-backup-"));
  try{await run(root,randomBytes(32));}finally{await rm(root,{recursive:true,force:true});}
}
async function create(root:string,key:Buffer,server=serverId){
  const directory=join(root,"source");await mkdir(directory);return new Vault(directory,key,server);
}
test("backup preserves encrypted principals, retained expired records, partial originals and opaque orphans without changing the source",()=>fixture(async(root,key)=>{
  const v=await create(root,key),directory=v.directory;
  v.replaceBinding("A","API-CANARY","key-A",0);v.put("A","secret",{value:"SECRET-A"},undefined,"same");v.put("B","secret",{value:"SECRET-B"},undefined,"same");
  v.put("A","secret",{value:"EXPIRED"},Date.now()-1000,"expired");
  const raw=await v.capture("A",stream(Buffer.from("ORIGINAL-CANARY")),1024),empty=await v.capture("B",stream(Buffer.alloc(0)),0);
  const partial=await v.capture("A",(async function*(){yield Buffer.from("partial");throw Error();})(),1024,undefined,undefined,true);
  const orphan="raw_"+randomUUID();await writeFile(join(directory,"objects",orphan),Buffer.from("opaque-unmapped-ciphertext"));
  await writeFile(join(directory,"private.key"),key);await writeFile(join(directory,".env"),"DO-NOT-COPY");
  const version=v.keyVersion;v.close();
  const before=await hashFile(join(directory,"vault.sqlite")),backup=join(root,"backup");
  const result=await backupVault({directory,key,serverId},backup);assert.equal(result.state,"backup_complete");assert.equal(result.preserved_orphans,1);assert.equal(result.originals,4);
  assert.deepEqual(await hashFile(join(directory,"vault.sqlite")),before);assert.equal(result.key_version,version);
  assert.ok(!(await readdir(backup)).includes("private.key"));assert.ok(!(await readdir(backup)).includes(".env"));
  const manifest=await verifyGenerationManifest(backup,key,serverId);assert.equal(manifest.operation,"backup");
  for(const f of manifest.files){
    const bytes=await readFile(join(backup,f.path));assert.ok(!bytes.includes(Buffer.from("API-CANARY")));assert.ok(!bytes.includes(Buffer.from("SECRET-A")));assert.ok(!bytes.includes(key));
  }
  assert.throws(()=>new Vault(backup,key,serverId),{code:"maintenance_incomplete"});await unlink(join(backup,".backup-only"));
  assert.throws(()=>new Vault(backup,key,serverId),{code:"backup_only"});
  assert.throws(()=>new Vault(backup,key,serverId,undefined,{},true),{code:"backup_only"});
  const snapshot=new Vault(backup,key,serverId,undefined,{},true,true);
  try{
    assert.equal(snapshot.readStored("A","same","secret").value,"SECRET-A");assert.equal(snapshot.readStored("B","same","secret").value,"SECRET-B");
    assert.equal(snapshot.readStored("A","expired","secret").value,"EXPIRED");
    assert.throws(()=>snapshot.put("A","secret",{}),{code:"snapshot_readonly"});assert.throws(()=>snapshot.disconnect("A",1),{code:"snapshot_readonly"});
    await assert.rejects(snapshot.capture("A",stream(Buffer.alloc(0)),0),{code:"snapshot_readonly"});
    for(const [p,id,bytes] of [["A",raw.raw_ref,"ORIGINAL-CANARY"],["B",empty.raw_ref,""],["A",partial.raw_ref,"partial"]]){
      assert.equal(Buffer.from(await new Response(snapshot.storedRawStream(p!,id!) as any).arrayBuffer()).toString(),bytes);
    }
    assert.equal(snapshot.readStored("A",partial.raw_ref,"raw").transfer_complete,false);
  }finally{snapshot.close();}
  await verifyGenerationManifest(backup,key,serverId);
}));
test("restore quarantines unsent and in-flight snapshot jobs, disconnects contexts, invalidates OAuth and never dispatches old work",()=>fixture(async(root,key)=>{
  const v=await create(root,key),directory=v.directory;v.replaceBinding("A","KEY-A","id-A",0);v.replaceBinding("B","KEY-B","id-B",0);
  const oldStore=v.get("__system","store_identity","store_identity").id;
  const executor=new Executor("http://immich/api",v,(async()=>{throw Error("No upstream during maintenance");}) as typeof fetch);
  const jobs=new Jobs(v,executor,resolver,{autoStart:false}),refs=[];
  for(const p of ["A","B","A","B","A"])refs.push(await jobs.submit(p,{operation_id:"getServerVersion"}));
  v.db.prepare("UPDATE jobs SET state='running',sent=0 WHERE id=?").run(refs[1]!.job_ref);
  v.db.prepare("UPDATE jobs SET state='running',sent=1 WHERE id=?").run(refs[2]!.job_ref);
  v.db.prepare("UPDATE jobs SET state='cancel_requested',sent=1 WHERE id=?").run(refs[3]!.job_ref);
  v.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(refs[4]!.job_ref);
  const expires=Date.now()+86400_000,context="context_"+randomUUID(),callback="callback_"+randomUUID();
  v.put("A","auth_context",{kind:"public",generation:3,bindingRevision:null,mode:"special",enabled:true,expires,upstream:"http://immich/api",secret:"OLD-CONTEXT-CANARY",cookies:{a:{value:"COOKIE"}},oauth:{state:"OLD-STATE"}},expires,context);
  v.put("A","oauth_callback",{used:false,context_ref:context,expires},expires,callback);
  v.db.exec("CREATE TABLE oauth_states(principal TEXT,digest TEXT,context_ref TEXT,flow_id TEXT,expires INTEGER)");
  v.db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?)").run("A","digest",context,"flow",expires);
  await jobs.close();await executor.close();v.close();
  const archive=join(root,"backup"),destination=join(root,"restored");await backupVault({directory,key,serverId},archive);
  const manifest=await readFile(join(archive,"manifest.json")),before=await hashFile(join(archive,"vault.sqlite"));
  const restored=await restoreVault(archive,destination,key,serverId);assert.equal(restored.quarantined_jobs,4);assert.equal(restored.disconnected_contexts,1);assert.equal(restored.invalidated_callbacks,1);assert.notEqual(restored.store_id,oldStore);
  await verifyGenerationManifest(destination,key,serverId);await verifyGenerationManifest(archive,key,serverId);
  assert.deepEqual(await readFile(join(archive,"manifest.json")),manifest);assert.deepEqual(await hashFile(join(archive,"vault.sqlite")),before);
  const current=new Vault(destination,key,serverId);let requests=0;
  const live=new Executor("http://immich/api",current,(async()=>{requests++;return Response.json({major:3,minor:3,patch:5});}) as typeof fetch);
  const contexts=new Contexts(current,live,"https://mcp.example"),queue=new Jobs(current,live,resolver);
  try{
    await queue.idle();assert.equal(requests,0);
    for(let i=0;i<4;i++){
      const p=i%2===0?"A":"B",state=queue.get(p,refs[i]!.job_ref);
      assert.equal(state.state,"outcome_unknown");assert.equal(state.diagnostic.code,"restored_snapshot_requires_review");
      assert.equal(state.diagnostic.details.request_may_have_been_sent,true);assert.equal(state.send_started,i>=2);
      assert.equal(current.storage.reservation(p,"status_"+refs[i]!.job_ref),undefined);
    }
    assert.equal(queue.get("A",refs[4]!.job_ref).state,"completed");
    assert.equal(current.get("A",context,"auth_context").enabled,false);assert.equal(current.get("A",context,"auth_context").generation,4);
    assert.deepEqual(current.get("A",context,"auth_context").cookies,{});assert.equal(current.get("A",context,"auth_context").secret,undefined);
    assert.equal(current.get("A",context,"auth_context").oauth,undefined);assert.equal(current.get("A",callback,"oauth_callback").used,true);
    assert.equal(current.db.prepare("SELECT COUNT(*) n FROM oauth_states").get()!.n,0);assert.throws(()=>contexts.check("A",context),{code:"invalid_context"});
    assert.equal(current.credential("A").key,"KEY-A");assert.equal(current.credential("B").key,"KEY-B");
  }finally{await queue.close();await live.close();current.close();}
}));
test("a version-one backup leaves source schema and ciphertext unchanged and migrates only the restored copy",()=>fixture(async(root,key)=>{
  const directory=join(root,"source");await mkdir(directory);await mkdir(join(directory,"objects"));
  const raw="raw_"+randomUUID(),plain=Buffer.from("LEGACY-BYTES"),nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([1,serverId,"A",raw,"raw"])));
  await writeFile(join(directory,"objects",raw),Buffer.concat([cipher.update(plain),cipher.final()]));
  const db=new DatabaseSync(join(directory,"vault.sqlite"));
  db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(1);CREATE TABLE records(principal TEXT,id TEXT,kind TEXT,payload BLOB,expires INTEGER,PRIMARY KEY(principal,id));CREATE TABLE bindings(principal TEXT PRIMARY KEY,revision INTEGER,credential TEXT,key_id TEXT,state TEXT)");
  const put=(p:string,id:string,kind:string,value:any)=>{
    const n=randomBytes(12),c=createCipheriv("aes-256-gcm",key,n);c.setAAD(Buffer.from(JSON.stringify([1,serverId,p,id,kind])));
    const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);db.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(p,id,kind,Buffer.concat([n,c.getAuthTag(),body]),Number.MAX_SAFE_INTEGER);
  };
  put("__system","key_check","check",{ok:true});put("A","secret","secret",{value:"OLD-SECRET"});
  put("A",raw,"raw",{nonce:nonce.toString("hex"),tag:cipher.getAuthTag().toString("hex"),size:plain.length,sha256:createHash("sha256").update(plain).digest("hex"),transfer_complete:true});db.close();
  const before=await hashFile(join(directory,"vault.sqlite")),archive=join(root,"backup");
  const b=await backupVault({directory,key,serverId},archive);assert.equal(b.schema_version,1);assert.equal(b.key_version,"legacy");
  assert.deepEqual(await hashFile(join(directory,"vault.sqlite")),before);
  const m=await verifyGenerationManifest(archive,key,serverId);assert.equal(m.schema_version,1);assert.equal(m.crypto_format,1);
  const destination=join(root,"restored");await restoreVault(archive,destination,key,serverId);
  const current=new Vault(destination,key,serverId);
  try{
    assert.equal(current.schemaVersion,2);assert.equal(current.get("A","secret","secret").value,"OLD-SECRET");
    assert.deepEqual(Buffer.from(await new Response(current.rawStream("A",raw) as any).arrayBuffer()),plain);
    assert.equal(current.get("A",raw,"raw").crypto.format,1);
  }finally{current.close();}
  assert.deepEqual(await hashFile(join(directory,"vault.sqlite")),before);await verifyGenerationManifest(archive,key,serverId);
}));
test("maintenance rejects live sources, overlapping or existing destinations, corrupt originals and wrong manifest credentials",()=>fixture(async(root,key)=>{
  const v=await create(root,key),directory=v.directory;
  const raw=await v.capture("A",stream(Buffer.from("GOOD")),100),location={directory,key,serverId};
  await assert.rejects(backupVault(location,join(root,"live")));
  await assert.rejects(backupVault(location,join(directory,"nested")),{code:"maintenance_path"});
  v.close();await assert.rejects(backupVault(location,root),{code:"maintenance_path"});
  const exists=join(root,"exists");await mkdir(exists);await assert.rejects(backupVault(location,exists),{code:"destination_exists"});
  const archive=join(root,"backup");await backupVault(location,archive);
  const denied=join(root,"denied");await assert.rejects(restoreVault(archive,denied,randomBytes(32),serverId),{code:"manifest_authentication"});
  await assert.rejects(restoreVault(archive,denied,key,"other-server"),{code:"manifest_authentication"});
  assert.ok(!(await readdir(root)).includes("denied"));
  const original=await readFile(join(directory,"objects",raw.raw_ref));original[0]=original[0]!^1;await writeFile(join(directory,"objects",raw.raw_ref),original);
  await assert.rejects(backupVault(location,join(root,"bad-source")));assert.ok(!(await readdir(root)).includes("bad-source"));
  const signed=await readFile(join(archive,"vault.sqlite"));signed[100]=signed[100]!^1;await writeFile(join(archive,"vault.sqlite"),signed);
  await assert.rejects(restoreVault(archive,denied,key,serverId),{code:"manifest_mismatch"});assert.ok(!(await readdir(root)).includes("denied"));
}));
test("separately configured source databases are included and restored to the new directory",()=>fixture(async(root,key)=>{
  const directory=join(root,"source");await mkdir(directory);const databasePath=join(root,"external.sqlite");
  const v=new Vault(directory,key,serverId,databasePath);v.put("A","secret",{value:"EXTERNAL"});v.close();
  const sourceBefore=await hashFile(databasePath),archive=join(root,"backup");await backupVault({directory,databasePath,key,serverId},archive);
  assert.deepEqual(await hashFile(databasePath),sourceBefore);await restoreVault(archive,join(root,"restored"),key,serverId);
  const current=new Vault(join(root,"restored"),key,serverId);try{assert.equal(current.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='secret'").get()!.n,1);}finally{current.close();}
}));
test("offline backup and restore CLI need no Cloudflare configuration or current active key",()=>fixture(async(root,key)=>{
  const upstream="http://immich/api",id=maintenanceServer({IMMICH_BASE_URL:upstream}),v=await create(root,key,id);v.replaceBinding("A","CLI-CANARY","key",0);const directory=v.directory;v.close();
  const keyFile=join(root,"old.key");await writeFile(keyFile,key);const archive=join(root,"backup"),destination=join(root,"restored");
  const env={...process.env,IMMICH_BASE_URL:upstream,STORAGE_PATH:directory,DATABASE_PATH:join(directory,"vault.sqlite"),VAULT_MASTER_KEY_FILE:keyFile};
  for(const k of Object.keys(env))if(k.startsWith("CF_ACCESS")||k==="PUBLIC_ORIGIN")delete(env as any)[k];
  const run=(args:string[],e:NodeJS.ProcessEnv)=>spawnSync(process.execPath,["--import","tsx","scripts/vault.ts",...args],{cwd:process.cwd(),env:e,encoding:"utf8",timeout:30000});
  const b=run(["backup","--to",archive],env);assert.equal(b.status,0,b.stderr);assert.equal(JSON.parse(b.stdout).state,"backup_complete");
  const recovery={...env};delete(recovery as any).VAULT_MASTER_KEY_FILE;delete(recovery as any).STORAGE_PATH;delete(recovery as any).DATABASE_PATH;
  const r=run(["restore","--from",archive,"--to",destination,"--key",keyFile],recovery);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,"ready_for_activation");
  assert.ok(!b.stdout.includes("CLI-CANARY"));assert.ok(!r.stdout.includes("CLI-CANARY"));
  const misplaced=join(directory,"master.key");await writeFile(misplaced,key);
  const denied=run(["backup","--to",join(root,"denied")],{...env,VAULT_MASTER_KEY_FILE:misplaced});
  assert.equal(denied.status,1);assert.equal(JSON.parse(denied.stderr).error.code,"key_not_separate");
  assert.ok(!(await readdir(root)).includes("denied"));

}));
