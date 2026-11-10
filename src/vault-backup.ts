import { DatabaseSync } from "node:sqlite";
import { createHash,randomUUID } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { lstat,mkdir,opendir,realpath,unlink,writeFile } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Vault } from "./vault.js";
import { decryptRecord,encryptRecord } from "./vault-crypto.js";
import { openStorageOwner,readVaultSchema,type VaultSchema } from "./vault-schema.js";
import { hashFile,OBJECT_LIMIT,verifyGenerationManifest,writeGenerationManifest,type ManifestFile } from "./vault-manifest.js";
import { syncDirectory,verifyStore,type VaultLocation } from "./vault-rekey.js";
import { BridgeError } from "./types.js";

const rawName=/^raw_[0-9a-f-]{36}$/i;
const within=(root:string,child:string)=>{const rel=relative(root,child);return rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel);};
async function absentFlag(directory:string,flag:string){
  try{await lstat(join(directory,flag));throw new BridgeError("maintenance_incomplete","Source is not a completed application generation");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
async function paths(source:string,destination:string,databasePath?:string){
  if(!isAbsolute(destination))throw new BridgeError("maintenance_path","Use an absolute destination with an existing parent");
  const directory=await realpath(source),parent=await realpath(dirname(resolve(destination))),target=join(parent,basename(resolve(destination)));
  const database=databasePath ?? join(directory,"vault.sqlite"),info=await lstat(database);
  if(!info.isFile()||info.isSymbolicLink())throw new BridgeError("maintenance_path","Source database must be a regular persistent file");
  if(within(directory,target)||within(target,directory)||within(target,resolve(database)))
    throw new BridgeError("maintenance_path","Source and destination must not overlap");
  return {directory,parent,target,database};
}
async function createCandidate(target:string,parent:string,backup=false){
  try{await mkdir(target,{mode:0o700});}
  catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new BridgeError("destination_exists","Destination must not already exist");throw error;}
  await writeFile(join(target,".maintenance-incomplete"),"Offline maintenance has not completed. Do not activate this directory.\n",{flag:"wx",mode:0o600,flush:true});
  if(backup)await writeFile(join(target,".backup-only"),"Restore this archive to a new application directory.\n",{flag:"wx",mode:0o600,flush:true});
  await mkdir(join(target,"objects"),{mode:0o700});await syncDirectory(parent);await syncDirectory(target);
}
async function copyVerified(source:string,target:string,expected:ManifestFile){
  const info=await lstat(source);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==expected.size)throw new BridgeError("maintenance_changed","Source file changed before copying");
  let size=0;const hash=createHash("sha256");
  const checked=new Transform({transform(chunk,_encoding,callback){
    size+=chunk.length;if(size>expected.size){callback(new BridgeError("maintenance_changed","Source file grew during copying"));return;}
    hash.update(chunk);callback(null,chunk);
  }});
  await pipeline(createReadStream(source),checked,createWriteStream(target,{flags:"wx",mode:0o600,flush:true}));
  if(size!==expected.size||hash.digest("hex")!==expected.sha256)throw new BridgeError("maintenance_changed","Source file changed during copying");
}
async function originals(vault:Vault){
  const expected=new Set<string>();
  for(const row of vault.db.prepare("SELECT id FROM records WHERE kind='raw'").iterate() as Iterable<{id:string}>){
    if(!rawName.test(row.id)||expected.has(row.id))throw new BridgeError("invalid_reference","Conflicting original identity");
    expected.add(row.id);if(expected.size>OBJECT_LIMIT)throw new BridgeError("manifest_limit","Offline original limit exceeded");
  }
  const files:ManifestFile[]=[];let orphaned=0,directory;
  try{
    const info=await lstat(join(vault.directory,"objects"));
    if(!info.isDirectory()||info.isSymbolicLink())throw new BridgeError("maintenance_path","Invalid originals directory");
    directory=await opendir(join(vault.directory,"objects"));
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(directory)for await(const entry of directory){
    if(!rawName.test(entry.name))continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw new BridgeError("maintenance_path","Original is not a regular file");
    if(files.length>=OBJECT_LIMIT)throw new BridgeError("manifest_limit","Offline original limit exceeded");
    if(!expected.delete(entry.name))orphaned++;
    files.push({path:"objects/"+entry.name,...await hashFile(join(vault.directory,"objects",entry.name))});
  }
  if(expected.size)throw new BridgeError("original_missing","An original file is unavailable");
  return {files,orphaned};
}
function writeRecord(db:DatabaseSync,schema:VaultSchema,key:Buffer,serverId:string,principal:string,id:string,kind:string,value:any,expires:number){
  const payload=encryptRecord(key,schema.format,schema.keyVersion,serverId,principal,id,kind,value);
  const columns="principal,id,kind,payload,expires"+(schema.version===2?",key_version":"");
  db.prepare("INSERT OR REPLACE INTO records("+columns+") VALUES("+ (schema.version===2?"?,?,?,?,?,?":"?,?,?,?,?")+")")
    .run(principal,id,kind,payload,expires,...(schema.version===2?[schema.keyVersion]:[]));
}
function checkpoint(db:DatabaseSync){
  const row=db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
  if(row.busy!==0)throw new BridgeError("store_busy","Target checkpoint is busy");
}
async function finish(target:string){
  await syncDirectory(join(target,"objects"));await syncDirectory(target);
  await unlink(join(target,".maintenance-incomplete"));await syncDirectory(target);
}
export async function backupVault(location:VaultLocation,destination:string){
  if(location.key.length!==32)throw new BridgeError("invalid_key","Supply a 32-byte master-key file");
  const p=await paths(location.directory,destination,location.databasePath);
  await absentFlag(p.directory,".maintenance-incomplete");await absentFlag(p.directory,".backup-only");
  let source:Vault|undefined,copied:Vault|undefined,database:DatabaseSync|undefined,owner:DatabaseSync|undefined;
  try{
    source=new Vault(p.directory,location.key,location.serverId,p.database,{},true,true);
    if(source.db.prepare("SELECT 1 FROM records WHERE principal='__system' AND id='store_role'").get())throw new BridgeError("backup_only","Use the original application generation as the backup source");
    const inventory=await originals(source);await verifyStore(source);
    const identity=source.db.prepare("SELECT 1 FROM records WHERE principal='__system' AND id='store_identity'").get();
    const originalId=identity?source.readStored("__system","store_identity","store_identity").id as string:undefined;
    const storeId=randomUUID(),backupId=randomUUID();
    await createCandidate(p.target,p.parent,true);
    // Bind a different identity before copying the main DB. A crash before
    // the archive role commits cannot leave an activatable source duplicate.
    await source.snapshotOwner(join(p.target,".storage-owner.sqlite"));
    owner=openStorageOwner(p.target);owner.prepare("INSERT OR REPLACE INTO owner_identity VALUES(1,?)").run(storeId);
    await source.snapshotMain(join(p.target,"vault.sqlite"));
    database=new DatabaseSync(join(p.target,"vault.sqlite"));
    database.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;");
    const schema=readVaultSchema(database,false);
    writeRecord(database,schema,location.key,location.serverId,"__system","store_identity","store_identity",{id:storeId},Number.MAX_SAFE_INTEGER);
    writeRecord(database,schema,location.key,location.serverId,"__system","store_role","store_role",{role:"backup",backup_id:backupId},Number.MAX_SAFE_INTEGER);
    database.exec("COMMIT");checkpoint(database);
    // Immutable archives use a standalone main file. Read-only inspection must
    // not create unsigned WAL/SHM files beside the authenticated inventory.
    database.exec("PRAGMA journal_mode=DELETE");database.close();database=undefined;owner.close();owner=undefined;
    for(const file of inventory.files)await copyVerified(join(p.directory,file.path),join(p.target,file.path),file);
    copied=new Vault(p.target,location.key,location.serverId,undefined,{},true,true);await verifyStore(copied);copied.close();copied=undefined;
    await writeGenerationManifest(p.target,{operation:"backup",schema_version:source.schemaVersion,crypto_format:source.schemaVersion,
      server_id:location.serverId,store_id:storeId,key_version:source.keyVersion,backup_id:backupId,...(originalId?{source:{store_id:originalId,key_version:source.keyVersion}}:{})},location.key);
    await verifyGenerationManifest(p.target,location.key,location.serverId);await finish(p.target);
    return {state:"backup_complete",directory:p.target,backup_id:backupId,schema_version:source.schemaVersion,key_version:source.keyVersion,originals:inventory.files.length,preserved_orphans:inventory.orphaned};
  }finally{
    if(database){if(database.isTransaction)database.exec("ROLLBACK");database.close();}
    owner?.close();copied?.close();source?.close();
  }
}

export async function restoreVault(archive:string,destination:string,key:Buffer,serverId:string){
  if(key.length!==32)throw new BridgeError("invalid_key","Supply the backup's 32-byte master-key file");
  await absentFlag(archive,".maintenance-incomplete");
  const manifest=await verifyGenerationManifest(archive,key,serverId);
  if(manifest.operation!=="backup"||!manifest.backup_id)throw new BridgeError("backup_required","Restore requires an authenticated backup archive");
  const p=await paths(archive,destination);
  let source:Vault|undefined,database:DatabaseSync|undefined,owner:DatabaseSync|undefined,verified:Vault|undefined;
  try{
    source=new Vault(p.directory,key,serverId,p.database,{},true,true);
    const role=source.readStored("__system","store_role","store_role");
    if(role.role!=="backup"||role.backup_id!==manifest.backup_id||source.schemaVersion!==manifest.schema_version||source.keyVersion!==manifest.key_version)
      throw new BridgeError("manifest_mismatch","Backup identity does not match the authenticated manifest");
    if(source.readStored("__system","store_identity","store_identity").id!==manifest.store_id)
      throw new BridgeError("manifest_mismatch","Backup storage identity does not match its manifest");
    await originals(source);await verifyStore(source);await verifyGenerationManifest(p.directory,key,serverId);
    await createCandidate(p.target,p.parent);
    const ordered=[...manifest.files].sort((a,b)=>Number(a.path.startsWith("objects/"))-Number(b.path.startsWith("objects/")));
    for(const file of ordered)await copyVerified(join(p.directory,file.path),join(p.target,file.path),file);
    const storeId=randomUUID(),now=Date.now(),recovery={quarantined_jobs:0,disconnected_contexts:0,invalidated_callbacks:0};
    owner=openStorageOwner(p.target);owner.prepare("INSERT OR REPLACE INTO owner_identity VALUES(1,?)").run(storeId);
    database=new DatabaseSync(join(p.target,"vault.sqlite"));
    database.exec("PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;");
    const schema=readVaultSchema(database,false),hasTable=(name:string)=>!!database!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const save=(row:any,value:any)=>writeRecord(database!,schema,key,serverId,row.principal,row.id,row.kind,value,row.expires);
    const read=(row:any)=>decryptRecord(key,schema.format,schema.keyVersion,serverId,row.principal,row.id,row.kind,row.payload);
    if(hasTable("jobs")){
      for(const job of database.prepare("SELECT * FROM jobs WHERE state IN ('queued','running','cancel_requested')").all() as any[]){
        const record=database.prepare("SELECT * FROM records WHERE principal=? AND id=? AND kind='job'").get(job.principal,job.id) as any;
        if(record)save(record,{...read(record),diagnostic:{code:"restored_snapshot_requires_review",
          message:"Effects since the backup are unknown. This job will not be replayed automatically.",
          details:{snapshot_send_started:job.sent===1,request_may_have_been_sent:true}}});
        database.prepare("UPDATE jobs SET state='outcome_unknown',updated=? WHERE principal=? AND id=?").run(now,job.principal,job.id);
        if(hasTable("storage_reservations"))database.prepare("DELETE FROM storage_reservations WHERE principal=? AND id=?").run(job.principal,"status_"+job.id);
        recovery.quarantined_jobs++;
      }
    }
    for(const record of database.prepare("SELECT * FROM records WHERE kind IN ('auth_context','oauth_callback')").all() as any[]){
      const value=read(record);
      if(record.kind==="auth_context"){
        const disabled={...value,enabled:false,generation:value.generation+1,cookies:{}};delete disabled.secret;delete disabled.oauth;
        save(record,disabled);recovery.disconnected_contexts++;
      }else{save(record,{...value,used:true});recovery.invalidated_callbacks++;}
    }
    if(hasTable("oauth_states"))database.exec("DELETE FROM oauth_states");
    writeRecord(database,schema,key,serverId,"__system","store_identity","store_identity",{id:storeId},Number.MAX_SAFE_INTEGER);
    writeRecord(database,schema,key,serverId,"__system","restore_notice","restore_notice",{source_backup_id:manifest.backup_id,restored_at:now,...recovery},Number.MAX_SAFE_INTEGER);
    database.prepare("DELETE FROM records WHERE principal='__system' AND id='store_role'").run();
    database.exec("COMMIT");checkpoint(database);database.close();database=undefined;owner.close();owner=undefined;
    verified=new Vault(p.target,key,serverId,undefined,{},true);await verifyStore(verified);
    const keyVersion=verified.keyVersion;checkpoint(verified.db);verified.close();verified=undefined;
    await writeGenerationManifest(p.target,{operation:"restore",schema_version:2,crypto_format:2,server_id:serverId,store_id:storeId,key_version:keyVersion,
      source_backup_id:manifest.backup_id,source:{store_id:manifest.store_id,key_version:manifest.key_version},recovery},key);
    await verifyGenerationManifest(p.target,key,serverId);await finish(p.target);
    return {state:"ready_for_activation",directory:p.target,source_backup_id:manifest.backup_id,store_id:storeId,key_version:keyVersion,...recovery};
  }finally{
    if(database){if(database.isTransaction)database.exec("ROLLBACK");database.close();}
    owner?.close();verified?.close();source?.close();
  }
}
