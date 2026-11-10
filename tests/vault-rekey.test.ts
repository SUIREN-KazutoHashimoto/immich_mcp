import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes,randomUUID,createCipheriv } from "node:crypto";
import { mkdtemp,mkdir,readFile,writeFile,lstat,stat,unlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn,spawnSync } from "node:child_process";
import { Vault } from "../src/vault.js";
import { rekeyVault,type VaultLocation } from "../src/vault-rekey.js";
import { verifyGenerationManifest,hashFile } from "../src/vault-manifest.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { maintenanceServer } from "../scripts/vault.js";
const serverId="rotation-test",source=(bytes:Uint8Array)=>(async function*(){yield bytes;})();
const resolver=()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}});
async function fixture(run:(v:Vault,location:VaultLocation,key:Buffer,root:string)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"immich-key-rotation-")),directory=join(root,"source"),oldKey=randomBytes(32),nextKey=randomBytes(32);await mkdir(directory);
  const vault=new Vault(directory,oldKey,serverId);
  try{await run(vault,{directory,key:oldKey,serverId},nextKey,root);}finally{vault.close();await rm(root,{recursive:true,force:true});}
}
test("key rotation reencrypts every principal, legacy/partial/empty original and durable job without changing references",()=>fixture(async(v,location,nextKey,root)=>{
  v.replaceBinding("A","API-KEY-CANARY","key-id",0);v.put("A","secret",{value:"SECRET-A"} ,undefined,"same-ref");v.put("B","secret",{value:"SECRET-B"},undefined,"same-ref");
  const bytes=Buffer.from("ORIGINAL-LEGACY-\u96ea"),raw=await v.capture("A",source(bytes),1024),empty=await v.capture("A",source(Buffer.alloc(0)),0);
  const partial=await v.capture("B",(async function*(){yield Buffer.from("partial");throw Error("interrupted");})(),1024,undefined,undefined,true);
  const nonce=randomBytes(12),legacy=createCipheriv("aes-256-gcm",location.key,nonce);legacy.setAAD(Buffer.from(JSON.stringify([1,serverId,"A",raw.raw_ref,"raw"])));
  const legacyBytes=Buffer.concat([legacy.update(bytes),legacy.final()]);await writeFile(join(location.directory,"objects",raw.raw_ref),legacyBytes);
  v.put("A","raw",{...v.get("A",raw.raw_ref,"raw"),nonce:nonce.toString("hex"),tag:legacy.getAuthTag().toString("hex"),crypto:{format:1,key_version:v.keyVersion}},undefined,raw.raw_ref);
  const executor=new Executor("http://immich/api",v,(async()=>{throw Error("No network during offline rotation");}) as typeof fetch),jobs=new Jobs(v,executor,resolver,{autoStart:false});
  const queued=await jobs.submit("A",{operation_id:"getServerVersion"}),sent=await jobs.submit("A",{operation_id:"getServerVersion"});
  v.db.prepare("UPDATE jobs SET state='running',sent=1 WHERE id=?").run(sent.job_ref);await jobs.close();await executor.close();
  const keyVersion=v.keyVersion,storeId=v.get("__system","store_identity","store_identity").id;
  const oldPayload=Buffer.from((v.db.prepare("SELECT payload FROM records WHERE principal='A' AND id='same-ref'").get() as any).payload);
  const before=await hashFile(join(location.directory,"objects",raw.raw_ref));v.close();
  const destination=join(root,"next"),result=await rekeyVault(location,destination,nextKey);assert.equal(result.state,"ready_for_activation");assert.equal(result.originals,3);
  assert.notEqual(result.key_version,keyVersion);assert.notEqual(result.store_id,storeId);
  const manifest=await verifyGenerationManifest(destination,nextKey,serverId);assert.equal(manifest.operation,"rekey");assert.equal(manifest.files.length,5);
  assert.equal(manifest.source!.key_version,keyVersion);
  for(const file of manifest.files){const cipher=await readFile(join(destination,...file.path.split("/")));assert.ok(!cipher.includes(location.key));assert.ok(!cipher.includes(nextKey));assert.ok(!cipher.includes(Buffer.from("API-KEY-CANARY")));}
  assert.deepEqual(await hashFile(join(location.directory,"objects",raw.raw_ref)),before);
  assert.throws(()=>new Vault(destination,location.key,serverId));
  const current=new Vault(destination,nextKey,serverId);
  try{
    assert.equal(current.credential("A").key,"API-KEY-CANARY");assert.equal(current.credential("A").revision,1);
    assert.equal(current.get("A","same-ref","secret").value,"SECRET-A");assert.equal(current.get("B","same-ref","secret").value,"SECRET-B");
    for(const [p,ref,expected]of [["A",raw.raw_ref,bytes],["A",empty.raw_ref,Buffer.alloc(0)],["B",partial.raw_ref,Buffer.from("partial")]] as const){
      const meta=current.get(p,ref,"raw");assert.equal(meta.crypto.format,2);assert.equal(meta.crypto.key_version,result.key_version);
      assert.deepEqual(Buffer.from(await new Response(current.rawStream(p,ref) as any).arrayBuffer()),expected);
    }
    assert.equal(current.get("B",partial.raw_ref,"raw").transfer_complete,false);
    const restoredJobs=new Jobs(current,new Executor("http://immich/api",current,(async()=>{throw Error();}) as typeof fetch),resolver,{autoStart:false});
    try{assert.equal(restoredJobs.get("A",sent.job_ref).state,"outcome_unknown");assert.equal(restoredJobs.get("A",queued.job_ref).state,"queued");}finally{await restoredJobs.close();}
  }finally{current.close();}
  assert.throws(()=>new Vault(location.directory,nextKey,serverId,join(destination,"vault.sqlite")),{code:"store_identity_mismatch"});
  const original=new Vault(location.directory,location.key,serverId);
  try{assert.equal(original.keyVersion,keyVersion);assert.deepEqual(Buffer.from((original.db.prepare("SELECT payload FROM records WHERE principal='A' AND id='same-ref'").get() as any).payload),oldPayload);}finally{original.close();}
}));
test("key rotation refuses live ownership, unchanged keys, overlaps, existing destinations and staged sources",()=>fixture(async(v,location,nextKey,root)=>{
  const next=join(root,"next");await assert.rejects(rekeyVault(location,next,nextKey));await assert.rejects(lstat(next),{code:"ENOENT"});
  await assert.rejects(rekeyVault(location,next,location.key),{code:"key_unchanged"});v.close();
  await assert.rejects(rekeyVault(location,join(location.directory,"nested"),nextKey),{code:"maintenance_path"});
  await assert.rejects(rekeyVault(location,"relative",nextKey),{code:"maintenance_path"});
  await mkdir(next);await writeFile(join(next,"keep.txt"),"preserve");await assert.rejects(rekeyVault(location,next,nextKey),{code:"destination_exists"});assert.equal(await readFile(join(next,"keep.txt"),"utf8"),"preserve");
  await writeFile(join(location.directory,".backup-only"),"backup");
  await assert.rejects(rekeyVault(location,join(root,"other"),nextKey),{code:"maintenance_incomplete"});
}));
test("failed original authentication leaves a blocked candidate and keeps the source available",()=>fixture(async(v,location,nextKey,root)=>{
  const raw=await v.capture("A",source(Buffer.from("CORRUPT-ME")),1024),path=join(location.directory,"objects",raw.raw_ref),original=await readFile(path);v.close();
  const damaged=Buffer.from(original);damaged[0]=damaged[0]!^1;await writeFile(path,damaged);
  const destination=join(root,"failed");await assert.rejects(rekeyVault(location,destination,nextKey));assert.ok((await lstat(join(destination,".maintenance-incomplete"))).isFile());
  assert.throws(()=>new Vault(destination,nextKey,serverId),{code:"maintenance_incomplete"});assert.deepEqual(await readFile(path),damaged);
  await writeFile(path,original);
  const reopened=new Vault(location.directory,location.key,serverId);try{assert.equal(Buffer.from(await new Response(reopened.rawStream("A",raw.raw_ref) as any).arrayBuffer()).toString(),"CORRUPT-ME");}finally{reopened.close();}
}));
test("missing originals and unresolved orphan files block rotation before creating a destination",()=>fixture(async(v,location,nextKey,root)=>{
  const raw=await v.capture("A",source(Buffer.from("original")),1024),path=join(location.directory,"objects",raw.raw_ref),bytes=await readFile(path);v.close();await unlink(path);
  const destination=join(root,"not-created");await assert.rejects(rekeyVault(location,destination,nextKey),{code:"original_missing"});await assert.rejects(lstat(destination),{code:"ENOENT"});
  await writeFile(path,bytes);const orphan=join(location.directory,"objects","raw_"+randomUUID());await writeFile(orphan,"ORPHAN-CANARY");
  await assert.rejects(rekeyVault(location,destination,nextKey),{code:"unresolved_orphan"});assert.equal(await readFile(orphan,"utf8"),"ORPHAN-CANARY");await assert.rejects(lstat(destination),{code:"ENOENT"});
}));
test("offline manifests authenticate SQL state, ciphertext inventory and the supplied key",()=>fixture(async(v,location,nextKey,root)=>{
  v.put("A","secret",{value:"MANIFEST-CANARY"});v.close();const destination=join(root,"signed");await rekeyVault(location,destination,nextKey);
  await assert.rejects(verifyGenerationManifest(destination,location.key,serverId),{code:"manifest_authentication"});
  const path=join(destination,"manifest.json"),original=await readFile(path),envelope=JSON.parse(original.toString()),payload=JSON.parse(envelope.payload);payload.store_id=randomUUID();envelope.payload=JSON.stringify(payload);
  await writeFile(path,JSON.stringify(envelope));await assert.rejects(verifyGenerationManifest(destination,nextKey,serverId),{code:"manifest_authentication"});await writeFile(path,original);
  const database=join(destination,"vault.sqlite"),bytes=await readFile(database);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;await writeFile(database,bytes);
  await assert.rejects(verifyGenerationManifest(destination,nextKey,serverId),{code:"manifest_mismatch"});
}));
test("the offline CLI rotates and verifies without Cloudflare settings or the old key file",()=>fixture(async(v,_location,nextKey,root)=>{
  v.close();const directory=join(root,"cli-source");await mkdir(directory);
  const upstream="http://immich.test/api/",identity=maintenanceServer({IMMICH_BASE_URL:upstream}),old=randomBytes(32),stored=new Vault(directory,old,identity);stored.put("A","secret",{value:"CLI-PRIVATE-CANARY"});stored.close();
  const oldFile=join(root,"old.key"),newFile=join(root,"new.key"),destination=join(root,"cli-next");await writeFile(oldFile,old);await writeFile(newFile,nextKey);
  const env={...process.env,IMMICH_BASE_URL:upstream,STORAGE_PATH:directory,DATABASE_PATH:join(directory,"vault.sqlite"),VAULT_MASTER_KEY_FILE:oldFile};
  const run=(args:string[])=>spawnSync(process.execPath,["--import","tsx","scripts/vault.ts",...args],{env,encoding:"utf8",timeout:60000,windowsHide:true});
  const rotated=run(["rekey","--to",destination,"--new-key",newFile]);assert.equal(rotated.status,0,rotated.stderr);assert.equal(JSON.parse(rotated.stdout).state,"ready_for_activation");
  await unlink(oldFile);const verified=run(["verify","--directory",destination,"--key",newFile]);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).state,"verified");
  const text=rotated.stdout+rotated.stderr+verified.stdout+verified.stderr;for(const canary of ["CLI-PRIVATE-CANARY",old.toString("hex"),nextKey.toString("hex")])assert.ok(!text.includes(canary));
}));
