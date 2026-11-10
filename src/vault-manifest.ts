import { createHash,createHmac,hkdfSync,timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat,opendir,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validVersion } from "./vault-crypto.js";
import { BridgeError } from "./types.js";
export const MANIFEST_LIMIT=32*1024*1024,OBJECT_LIMIT=100000;
export interface ManifestFile {path:string;size:number;sha256:string;}
export interface GenerationMetadata {
  operation:"rekey"|"backup"|"restore";schema_version:1|2;crypto_format:1|2;server_id:string;store_id:string;key_version:string;
  source?:{store_id:string;key_version:string};backup_id?:string;source_backup_id?:string;
  recovery?:{quarantined_jobs:number;disconnected_contexts:number;invalidated_callbacks:number};
}
export interface GenerationManifest extends GenerationMetadata {format:"immich-mcp-generation";version:1;state:"complete";created_at:string;files:ManifestFile[];}
const rawName=/^raw_[0-9a-f-]{36}$/i;
const safePath=(value:unknown):value is string=>typeof value==="string"&&(value==="vault.sqlite"||value===".storage-owner.sqlite"||/^objects\/raw_[0-9a-f-]{36}$/i.test(value));
export async function hashFile(path:string){
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new BridgeError("maintenance_path","Expected a regular owned file");
  const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(path)){bytes+=chunk.length;hash.update(chunk);}
  if(bytes!==info.size)throw new BridgeError("maintenance_changed","File changed during maintenance");
  return {size:bytes,sha256:hash.digest("hex")};
}
export async function generationFiles(directory:string){
  // A WAL or rollback journal may contain database changes not represented by
  // the signed main-file hash. Empty WALs created by a reader carry no state.
  for(const name of ["vault.sqlite",".storage-owner.sqlite"])for(const suffix of ["-wal","-journal"]){
    try{
      const info=await lstat(join(directory,name+suffix));
      if(!info.isFile()||info.isSymbolicLink()||info.size!==0)throw new BridgeError("uncheckpointed_backup","Offline databases must be fully checkpointed");
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  const files:ManifestFile[]=[];
  for(const path of ["vault.sqlite",".storage-owner.sqlite"])files.push({path,...await hashFile(join(directory,path))});
  let objects;
  try{const info=await lstat(join(directory,"objects"));if(!info.isDirectory()||info.isSymbolicLink())throw new BridgeError("maintenance_path","Invalid objects directory");objects=await opendir(join(directory,"objects"));}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(objects)for await(const entry of objects){
    if(!rawName.test(entry.name))continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw new BridgeError("maintenance_path","Invalid owned object");
    if(files.length>=OBJECT_LIMIT+2)throw new BridgeError("manifest_limit","Offline manifest object limit exceeded");
    files.push({path:"objects/"+entry.name,...await hashFile(join(directory,"objects",entry.name))});
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
function signature(payload:string,key:Buffer,serverId:string){
  const derived=Buffer.from(hkdfSync("sha256",key,Buffer.from(serverId),Buffer.from("immich-mcp-offline-manifest-v1"),32));
  try{return createHmac("sha256",derived).update("immich-mcp-manifest-v1\n").update(payload).digest();}
  finally{derived.fill(0);}
}
export async function writeGenerationManifest(directory:string,metadata:GenerationMetadata,key:Buffer){
  if(key.length!==32)throw Error("Invalid manifest key");
  const payload:GenerationManifest={...metadata,format:"immich-mcp-generation",version:1,state:"complete",created_at:new Date().toISOString(),files:await generationFiles(directory)};
  const serialized=JSON.stringify(payload),document=JSON.stringify({format:1,payload:serialized,mac:signature(serialized,key,metadata.server_id).toString("hex")})+"\n";
  if(Buffer.byteLength(document)>MANIFEST_LIMIT)throw new BridgeError("manifest_limit","Offline manifest exceeds the size limit");
  await writeFile(join(directory,"manifest.json"),document,{flag:"wx",mode:0o600,flush:true});return payload;
}
export async function verifyGenerationManifest(directory:string,key:Buffer,serverId:string):Promise<GenerationManifest>{
  const path=join(directory,"manifest.json"),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>MANIFEST_LIMIT)throw new BridgeError("invalid_manifest","Invalid offline manifest");
  const parts:Buffer[]=[];let received=0;
  for await(const chunk of createReadStream(path)){received+=chunk.length;if(received>MANIFEST_LIMIT)throw new BridgeError("manifest_limit","Offline manifest exceeds the size limit");parts.push(Buffer.from(chunk));}
  const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)));
  if(envelope?.format!==1||typeof envelope.payload!=="string"||!(/^[a-f0-9]{64}$/).test(envelope.mac))
    throw new BridgeError("invalid_manifest","Invalid offline manifest envelope");
  const expected=signature(envelope.payload,key,serverId);
  if(!timingSafeEqual(expected,Buffer.from(envelope.mac,"hex")))throw new BridgeError("manifest_authentication","Offline manifest authentication failed");
  const value=JSON.parse(envelope.payload) as GenerationManifest;
  if(value.format!=="immich-mcp-generation"||value.version!==1||value.state!=="complete"||!["rekey","backup","restore"].includes(value.operation)||
    !(value.schema_version===1&&value.crypto_format===1&&value.key_version==="legacy"||value.schema_version===2&&value.crypto_format===2&&validVersion(value.key_version))||value.server_id!==serverId||!validVersion(value.store_id)||
    value.operation==="backup"&&!validVersion(value.backup_id)||value.operation==="restore"&&!validVersion(value.source_backup_id)||
    !Number.isFinite(Date.parse(value.created_at))||!Array.isArray(value.files)||value.files.length>OBJECT_LIMIT+2)
    throw new BridgeError("invalid_manifest","Invalid offline generation metadata");
  const paths=new Set<string>();
  for(const file of value.files){
    if(!safePath(file.path)||paths.has(file.path.toLowerCase())||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))
      throw new BridgeError("invalid_manifest","Invalid offline file inventory");
    paths.add(file.path.toLowerCase());
  }
  if(!paths.has("vault.sqlite")||!paths.has(".storage-owner.sqlite"))throw new BridgeError("invalid_manifest","Offline database inventory is incomplete");
  const actual=await generationFiles(directory);
  if(actual.length!==value.files.length)throw new BridgeError("manifest_mismatch","Offline file inventory changed");
  const sorted=[...value.files].sort((a,b)=>a.path.localeCompare(b.path));
  if(actual.some((f,i)=>f.path!==sorted[i]!.path||f.size!==sorted[i]!.size||f.sha256!==sorted[i]!.sha256))
    throw new BridgeError("manifest_mismatch","Offline file content changed");
  return value;
}
