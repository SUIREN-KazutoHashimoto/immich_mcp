import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes,randomUUID,createHash,createHmac,hkdfSync } from "node:crypto";
import { mkdtemp,mkdir,readFile,writeFile,rm,readdir,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { backupVault,restoreVault } from "../src/vault-backup.js";
import { rekeyVault } from "../src/vault-rekey.js";
import { verifyGenerationManifest,hashFile } from "../src/vault-manifest.js";
import { Uploads } from "../src/uploads.js";
import { Staging } from "../src/staging.js";
import { DownloadPolicy } from "../src/download.js";
const serverId="backup-boundaries",source=(bytes:Uint8Array)=>(async function*(){yield bytes;})();
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
async function fixture(run:(v:Vault,root:string,key:Buffer)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"immich-backup-boundaries-")),directory=join(root,"source"),key=randomBytes(32);await mkdir(directory);
  const v=new Vault(directory,key,serverId);try{await run(v,root,key);}finally{v.close();await rm(root,{recursive:true,force:true});}
}
test("an offline snapshot holds database ownership against an application using a different objects directory",()=>fixture(async(v,root,key)=>{
  const directory=v.directory;v.close();const snapshot=new Vault(directory,key,serverId,undefined,{},true,true);
  const other=join(root,"other");await mkdir(other);
  try{
    assert.throws(()=>new Vault(other,key,serverId,join(directory,"vault.sqlite")));
    assert.throws(()=>snapshot.db.exec("DELETE FROM records"));
    assert.equal(snapshot.readStored("__system","key_check","check").ok,true);
  }finally{snapshot.close();}
}));
test("a lost owner binding can be backed up without adopting or deleting opaque originals",()=>fixture(async(v,root,key)=>{
  const directory=v.directory,orphan="raw_"+randomUUID();await mkdir(join(directory,"objects"));await writeFile(join(directory,"objects",orphan),randomBytes(81));v.close();
  const owner=new DatabaseSync(join(directory,".storage-owner.sqlite"));owner.exec("DELETE FROM owner_identity");owner.close();
  const before=await hashFile(join(directory,"vault.sqlite")),archive=join(root,"backup");
  assert.equal((await backupVault({directory,key,serverId},archive)).preserved_orphans,1);
  assert.deepEqual(await hashFile(join(directory,"vault.sqlite")),before);
  const check=new DatabaseSync(join(directory,".storage-owner.sqlite"));try{assert.equal(check.prepare("SELECT COUNT(*) n FROM owner_identity").get()!.n,0);}finally{check.close();}
  assert.throws(()=>new Vault(directory,key,serverId),{code:"store_identity_mismatch"});
  await restoreVault(archive,join(root,"restored"),key,serverId);
  assert.deepEqual(await readFile(join(root,"restored","objects",orphan)),await readFile(join(directory,"objects",orphan)));
}));
test("a resumable local upload keeps acknowledged chunks and can finish after restoration",()=>fixture(async(v,root,key)=>{
  const directory=v.directory,bytes=Buffer.from([0,255,1,8,9,10,0,128]);v.replaceBinding("A","key","id",0);
  const staging=new Staging(v,new DownloadPolicy([]),{maxFileBytes:32,quotaBytes:64}),uploads=new Uploads(staging,3);
  const start=uploads.start("A",{filename:"image.bin",mime:"application/octet-stream",size:bytes.length,sha256:sha(bytes)});
  await uploads.append("A",start.upload_ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3)));
  const expires=uploads.status("A",start.upload_ref).expires_at;v.close();
  const archive=join(root,"backup");await backupVault({directory,key,serverId},archive);await restoreVault(archive,join(root,"restored"),key,serverId);
  const current=new Vault(join(root,"restored"),key,serverId),s=new Staging(current,new DownloadPolicy([]),{maxFileBytes:32,quotaBytes:64}),u=new Uploads(s,3);
  try{
    assert.equal(u.status("A",start.upload_ref).next_chunk,1);assert.equal(u.status("A",start.upload_ref).expires_at,expires);assert.throws(()=>u.status("B",start.upload_ref));
    await u.append("A",start.upload_ref,0,sha(bytes.subarray(0,3)),source(bytes.subarray(0,3)));
    for(let i=1;i<3;i++){const b=bytes.subarray(i*3,(i+1)*3);await u.append("A",start.upload_ref,i,sha(b),source(b));}
    const completed=await u.complete("A",start.upload_ref),part=await s.file("A",completed.file_ref);
    assert.deepEqual(Buffer.from(await new Response(part.open() as any).arrayBuffer()),bytes);
  }finally{current.close();}
  await verifyGenerationManifest(archive,key,serverId);
}));
test("missing original files stop a backup before any candidate is created",()=>fixture(async(v,root,key)=>{
  const raw=await v.capture("A",source(Buffer.from("bytes")),64),directory=v.directory;v.close();await unlink(join(directory,"objects",raw.raw_ref));
  await assert.rejects(backupVault({directory,key,serverId},join(root,"backup")),{code:"original_missing"});
  assert.ok(!(await readdir(root)).includes("backup"));
}));
test("archives with uncheckpointed SQLite state or incomplete markers cannot be restored",()=>fixture(async(v,root,key)=>{
  const directory=v.directory;v.close();const archive=join(root,"backup"),target=join(root,"target");await backupVault({directory,key,serverId},archive);
  await writeFile(join(archive,"vault.sqlite-wal"),Buffer.from("unsigned-WAL-state"));
  await assert.rejects(verifyGenerationManifest(archive,key,serverId),{code:"uncheckpointed_backup"});
  await assert.rejects(restoreVault(archive,target,key,serverId),{code:"uncheckpointed_backup"});await unlink(join(archive,"vault.sqlite-wal"));
  await writeFile(join(archive,".maintenance-incomplete"),"not finished");
  await assert.rejects(restoreVault(archive,target,key,serverId),{code:"maintenance_incomplete"});assert.ok(!(await readdir(root)).includes("target"));
}));
test("authenticated manifests still reject traversal and case-colliding original paths before restoration",()=>fixture(async(v,root,key)=>{
  const directory=v.directory;await v.capture("A",source(Buffer.from("bytes")),32);v.close();const archive=join(root,"backup"),target=join(root,"target");await backupVault({directory,key,serverId},archive);
  const document=await readFile(join(archive,"manifest.json"),"utf8"),envelope=JSON.parse(document),manifest=JSON.parse(envelope.payload);
  const sign=async(value:any)=>{
    const payload=JSON.stringify(value),derived=Buffer.from(hkdfSync("sha256",key,Buffer.from(serverId),Buffer.from("immich-mcp-offline-manifest-v1"),32));
    const mac=createHmac("sha256",derived).update("immich-mcp-manifest-v1\n").update(payload).digest("hex");derived.fill(0);
    await writeFile(join(archive,"manifest.json"),JSON.stringify({format:1,payload,mac}));
  };
  const raw=manifest.files.find((f:any)=>f.path.startsWith("objects/"));
  for(const path of ["../outside",raw.path.toUpperCase()]){
    await sign({...manifest,files:[...manifest.files,{...raw,path}]});
    await assert.rejects(restoreVault(archive,target,key,serverId),{code:"invalid_manifest"});assert.ok(!(await readdir(root)).includes("target"));
  }
  await writeFile(join(archive,"manifest.json"),document);await unlink(join(archive,".backup-only"));
  await assert.rejects(backupVault({directory:archive,key,serverId},target),{code:"backup_only"});
  await assert.rejects(rekeyVault({directory:archive,key,serverId},target,randomBytes(32)),{code:"backup_only"});
}));
