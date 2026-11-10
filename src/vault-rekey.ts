import { DatabaseSync } from "node:sqlite";
import { createCipheriv,createHash,randomBytes,randomUUID,timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat,mkdir,opendir,open,realpath,unlink,writeFile } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Vault } from "./vault.js";
import { encryptRecord,vaultAad } from "./vault-crypto.js";
import { openStorageOwner } from "./vault-schema.js";
import { OBJECT_LIMIT,writeGenerationManifest,verifyGenerationManifest } from "./vault-manifest.js";
import { BridgeError } from "./types.js";

export interface VaultLocation {directory:string;databasePath?:string;key:Buffer;serverId:string;}
const within=(root:string,child:string)=>{const rel=relative(root,child);return rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel);};
const rawName=/^raw_[0-9a-f-]{36}$/i;
export async function syncDirectory(path:string){
  if(process.platform==="win32")return;
  const handle=await open(path,"r");try{await handle.sync();}finally{await handle.close();}
}
async function validateObjects(vault:Vault){
  const expected=new Set<string>();
  for(const row of vault.db.prepare("SELECT id FROM records WHERE kind='raw'").iterate() as Iterable<{id:string}>){
    if(!rawName.test(row.id)||expected.has(row.id))throw new BridgeError("invalid_reference","Conflicting original identity");
    expected.add(row.id);if(expected.size>OBJECT_LIMIT)throw new BridgeError("manifest_limit","Offline object limit exceeded");
  }
  let directory;
  try{
    const info=await lstat(join(vault.directory,"objects"));
    if(!info.isDirectory()||info.isSymbolicLink())throw new BridgeError("maintenance_path","Invalid originals directory");
    directory=await opendir(join(vault.directory,"objects"));
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(directory)for await(const entry of directory){
    if(!rawName.test(entry.name))continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw new BridgeError("maintenance_path","Original is not a regular file");
    if(!expected.delete(entry.name))throw new BridgeError("unresolved_orphan","Resolve unreferenced originals before key rotation");
  }
  if(expected.size)throw new BridgeError("original_missing","An original file is unavailable");
}
export async function verifyStore(vault:Vault){
  const integrity=vault.db.prepare("PRAGMA integrity_check").all();
  if(integrity.length!==1||Object.values(integrity[0]!)[0]!=="ok")throw new BridgeError("integrity_failed","SQLite integrity verification failed");
  for(const row of vault.db.prepare("SELECT principal,id,kind FROM records ORDER BY rowid").iterate() as Iterable<{principal:string;id:string;kind:string}>){
    const value=vault.readStored(row.principal,row.id,row.kind);
    if(row.kind!=="raw")continue;
    let size=0;const hash=createHash("sha256");
    for await(const chunk of vault.storedRawStream(row.principal,row.id)){size+=chunk.length;hash.update(chunk);}
    if(size!==value.size||hash.digest("hex")!==value.sha256)throw new BridgeError("original_mismatch","Original plaintext integrity verification failed");
  }
}
export async function rekeyVault(location:VaultLocation,destination:string,newKey:Buffer){
  if(location.key.length!==32||newKey.length!==32)throw new BridgeError("invalid_key","Supply both 32-byte key files");
  if(timingSafeEqual(location.key,newKey))throw new BridgeError("key_unchanged","Key rotation requires different key material");
  if(!isAbsolute(destination))throw new BridgeError("maintenance_path","Use an absolute destination with an existing parent");
  const sourceDirectory=await realpath(location.directory),parent=await realpath(dirname(resolve(destination))),target=join(parent,basename(resolve(destination)));
  for(const flag of [".maintenance-incomplete",".backup-only"]){
    try{await lstat(join(sourceDirectory,flag));throw new BridgeError("maintenance_incomplete","Source must be an activated application generation");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  const databasePath=location.databasePath ?? join(sourceDirectory,"vault.sqlite"),databaseInfo=await lstat(databasePath);
  if(!databaseInfo.isFile()||databaseInfo.isSymbolicLink())throw new BridgeError("maintenance_path","Source database must be a regular persistent file");
  if(within(sourceDirectory,target)||within(target,sourceDirectory)||within(target,resolve(databasePath)))
    throw new BridgeError("maintenance_path","Source and destination must not overlap");
  let source:Vault|undefined,targetDatabase:DatabaseSync|undefined,targetOwner:DatabaseSync|undefined,verified:Vault|undefined;
  try{
    source=new Vault(sourceDirectory,location.key,location.serverId,databasePath,{},true);
    await validateObjects(source);
    const originalIdentity=source.readStored("__system","store_identity","store_identity").id as string;
    try{await mkdir(target,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new BridgeError("destination_exists","Destination must not already exist");throw error;}
    await writeFile(join(target,".maintenance-incomplete"),"Re-encryption has not completed. Do not activate this directory.\n",{flag:"wx",mode:0o600,flush:true});
    await syncDirectory(parent);await syncDirectory(target);
    await mkdir(join(target,"objects"),{mode:0o700});
    const keyVersion=randomUUID(),storeId=randomUUID();
    targetOwner=openStorageOwner(target);targetOwner.prepare("INSERT INTO owner_identity VALUES(1,?)").run(storeId);
    await source.snapshotMain(join(target,"vault.sqlite"));
    targetDatabase=new DatabaseSync(join(target,"vault.sqlite"));
    targetDatabase.exec("PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;");
    const update=targetDatabase.prepare("UPDATE records SET payload=?,key_version=? WHERE principal=? AND id=?");
    let records=0,originals=0;
    for(const row of source.db.prepare("SELECT principal,id,kind FROM records ORDER BY rowid").iterate() as Iterable<{principal:string;id:string;kind:string}>){
      let value=source.readStored(row.principal,row.id,row.kind);
      if(row.kind==="raw"){
        if(!Number.isSafeInteger(value.size)||value.size<0||!/^[a-f0-9]{64}$/.test(value.sha256))throw new BridgeError("invalid_reference","Invalid original integrity metadata");
        const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",newKey,nonce),hash=createHash("sha256");let size=0;
        cipher.setAAD(vaultAad(2,keyVersion,location.serverId,row.principal,row.id,"raw"));
        const count=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;hash.update(chunk);callback(null,chunk);}});
        await pipeline(source.storedRawStream(row.principal,row.id),count,cipher,createWriteStream(join(target,"objects",row.id),{flags:"wx",mode:0o600,flush:true}));
        if(size!==value.size||hash.digest("hex")!==value.sha256)throw new BridgeError("original_mismatch","Source original integrity verification failed");
        value={...value,nonce:nonce.toString("hex"),tag:cipher.getAuthTag().toString("hex"),crypto:{format:2,key_version:keyVersion}};originals++;
      }else if(row.principal==="__system"&&row.id==="store_identity"&&row.kind==="store_identity")value={id:storeId};
      update.run(encryptRecord(newKey,2,keyVersion,location.serverId,row.principal,row.id,row.kind,value),keyVersion,row.principal,row.id);records++;
    }
    targetDatabase.prepare("UPDATE vault_crypto SET key_version=? WHERE singleton=1").run(keyVersion);
    targetDatabase.exec("COMMIT;");
    targetDatabase.close();targetDatabase=undefined;targetOwner.close();targetOwner=undefined;
    await syncDirectory(join(target,"objects"));await syncDirectory(target);
    verified=new Vault(target,newKey,location.serverId,undefined,{},true);
    await verifyStore(verified);
    const checkpoint=verified.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
    if(checkpoint.busy!==0)throw new BridgeError("store_busy","Target database checkpoint is busy");
    verified.close();verified=undefined;
    await writeGenerationManifest(target,{operation:"rekey",schema_version:2,crypto_format:2,server_id:location.serverId,store_id:storeId,key_version:keyVersion,
      source:{store_id:originalIdentity,key_version:source.keyVersion}},newKey);
    await verifyGenerationManifest(target,newKey,location.serverId);
    await syncDirectory(target);await unlink(join(target,".maintenance-incomplete"));await syncDirectory(target);
    return {state:"ready_for_activation",directory:target,schema_version:2,key_version:keyVersion,store_id:storeId,records,originals};
  }finally{
    if(targetDatabase){if(targetDatabase.isTransaction)targetDatabase.exec("ROLLBACK");targetDatabase.close();}
    targetOwner?.close();verified?.close();source?.close();
  }
}
