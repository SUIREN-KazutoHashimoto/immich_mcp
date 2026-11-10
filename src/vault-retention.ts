import { DatabaseSync } from "node:sqlite";
import { createHmac,hkdfSync,randomUUID,timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat,opendir,readFile,realpath,rename,rmdir,unlink,writeFile } from "node:fs/promises";
import { dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { Vault } from "./vault.js";
import { validVersion } from "./vault-crypto.js";
import { hashFile,MANIFEST_LIMIT,verifyGenerationManifest,type ManifestFile } from "./vault-manifest.js";
import { syncDirectory } from "./vault-rekey.js";
import { BridgeError } from "./types.js";

const ARCHIVE_LIMIT=1000,PLAN_LIMIT=4*1024*1024,INTENT_LIMIT=MANIFEST_LIMIT+1024*1024;
type Identity={dev:string;ino:string};
interface Archive {
  name:string;identity:Identity;backup_id:string;store_id:string;created_at:string;manifest_sha256:string;
  files:number;bytes:number;action:"keep"|"delete";
}
export interface RetentionPlan {
  format:"immich-mcp-retention";version:1;id:string;server_id:string;root:string;identity:Identity;created_at:string;keep:number;
  archives:Archive[];skipped:{name:string;code:string}[];
}
export interface SealedRetention {format:1;payload:string;mac:string;}
interface Intent {
  format:"immich-mcp-retention-delete";version:1;plan_id:string;server_id:string;root:Identity;
  archive:Archive;files:ManifestFile[];
}
const fail=(code:string,message:string):never=>{throw new BridgeError(code,message);};
const same=(a:Identity,b:Identity)=>a.dev===b.dev&&a.ino===b.ino;
const safeName=(name:unknown):name is string=>typeof name==="string"&&name.length>0&&name.length<=255&&name!=="."&&name!==".."&&!/[<>:"/\\|?*\x00-\x1f]/.test(name)&&!/[. ]$/.test(name);
const filePath=(name:unknown):name is string=>typeof name==="string"&&["vault.sqlite",".storage-owner.sqlite","manifest.json",".backup-only"].includes(name)||typeof name==="string"&&/^objects\/raw_[0-9a-f-]{36}$/i.test(name);
async function directoryIdentity(path:string):Promise<Identity>{
  const info=await lstat(path,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())fail("retention_path","Expected a regular directory");
  return {dev:String(info.dev),ino:String(info.ino)};
}
async function rootPath(directory:string){
  if(!isAbsolute(directory))fail("retention_path","Use an absolute backup collection directory");
  const root=resolve(directory);if(await realpath(root)!==root||dirname(root)===root)fail("retention_path","Use the canonical non-root backup collection directory");
  return {root,identity:await directoryIdentity(root)};
}
async function sameDirectory(path:string,identity:Identity){
  if(await realpath(path)!==path||!same(await directoryIdentity(path),identity))fail("retention_changed","Directory identity changed");
}
function sign(payload:string,key:Buffer,serverId:string,purpose:"plan"|"delete"){
  if(key.length!==32)fail("invalid_key","Supply a 32-byte backup key");
  const derived=Buffer.from(hkdfSync("sha256",key,Buffer.from(serverId),Buffer.from("immich-mcp-retention-"+purpose+"-v1"),32));
  try{return createHmac("sha256",derived).update("immich-mcp-retention-"+purpose+"-v1\n").update(payload).digest();}
  finally{derived.fill(0);}
}
function seal(value:any,key:Buffer,serverId:string,purpose:"plan"|"delete"):SealedRetention{
  const payload=JSON.stringify(value);return {format:1,payload,mac:sign(payload,key,serverId,purpose).toString("hex")};
}
function unseal<T>(document:string,key:Buffer,serverId:string,purpose:"plan"|"delete"):T{
  const value=JSON.parse(document);
  if(value?.format!==1||typeof value.payload!=="string"||typeof value.mac!=="string"||!/^[a-f0-9]{64}$/.test(value.mac))fail("invalid_retention","Invalid retention envelope");
  if(!timingSafeEqual(sign(value.payload,key,serverId,purpose),Buffer.from(value.mac,"hex")))fail("retention_authentication","Retention authentication failed");
  return JSON.parse(value.payload) as T;
}
async function bounded(path:string,limit:number){
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>limit)fail("invalid_retention","Invalid retention document");
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of createReadStream(path)){bytes+=chunk.length;if(bytes>limit)fail("retention_limit","Retention document exceeds its limit");chunks.push(Buffer.from(chunk));}
  return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
}
async function exists(path:string){
  try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return false;}
}
async function lock(root:string){
  const path=join(root,".retention-owner.sqlite");
  if(await exists(path)){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail("retention_path","Invalid retention owner file");}
  const db=new DatabaseSync(path);
  try{
    db.exec("PRAGMA busy_timeout=1000;PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE;");
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get())db.exec("CREATE TABLE retention_owner(version INTEGER PRIMARY KEY);INSERT INTO retention_owner VALUES(1)");
    const rows=db.prepare("SELECT version FROM retention_owner").all();
    if(rows.length!==1||rows[0]!.version!==1)fail("retention_schema","Unsupported retention owner schema");
    db.exec("COMMIT");return db;
  }catch(error){if(db.isTransaction)db.exec("ROLLBACK");db.close();throw error;}
}
async function names(directory:string){
  const result:string[]=[];for await(const entry of await opendir(directory)){result.push(entry.name);if(result.length>100002)fail("retention_limit","Directory contains too many entries");}return result;
}
async function shape(directory:string,files:ManifestFile[],intent=false,partial=false){
  const allowed=new Set(files.map(f=>f.path)),top=new Set(["objects",...(intent?[".retention-delete.json"]:[]),...files.filter(f=>!f.path.startsWith("objects/")).map(f=>f.path)]);
  for(const name of await names(directory)){
    if(!top.has(name))fail("retention_extra_files","Archive contains files outside the deletion inventory");
    const info=await lstat(join(directory,name));
    if(info.isSymbolicLink()||(name==="objects"?!info.isDirectory():!info.isFile()))fail("retention_path","Archive contains an unsafe entry");
  }
  const objects=join(directory,"objects");
  if(await exists(objects))for(const name of await names(objects)){
    if(!allowed.has("objects/"+name))fail("retention_extra_files","Archive contains an unrelated object");
    const info=await lstat(join(objects,name));if(!info.isFile()||info.isSymbolicLink())fail("retention_path","Archive object is unsafe");
  }
  for(const file of files){
    if(!filePath(file.path)||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail("invalid_retention","Invalid deletion inventory");
    if(!await exists(join(directory,file.path))){if(partial)continue;fail("retention_changed","Archive file is missing");}
    const actual=await hashFile(join(directory,file.path));if(actual.size!==file.size||actual.sha256!==file.sha256)fail("retention_changed","Archive file changed");
  }
}
async function inspect(directory:string,key:Buffer,serverId:string){
  const identity=await directoryIdentity(directory),manifest=await verifyGenerationManifest(directory,key,serverId);
  if(manifest.operation!=="backup"||!manifest.backup_id)fail("backup_required","Retention only removes authenticated backups");
  if(Date.parse(manifest.created_at)>Date.now()+300000)fail("retention_future_backup","Backup creation time is in the future");
  const marker=join(directory,".backup-only"),notice="Restore this archive to a new application directory.\n";
  const markerInfo=await lstat(marker);
  if(!markerInfo.isFile()||markerInfo.isSymbolicLink()||markerInfo.size!==Buffer.byteLength(notice)||await readFile(marker,"utf8")!==notice)
    fail("backup_required","Archive marker is not recognized");
  const files=[...manifest.files,{path:"manifest.json",...await hashFile(join(directory,"manifest.json"))},{path:".backup-only",...await hashFile(join(directory,".backup-only"))}];
  await shape(directory,files);
  const vault=new Vault(directory,key,serverId,undefined,{},true,true);
  try{
    const role=vault.readStored("__system","store_role","store_role"),store=vault.readStored("__system","store_identity","store_identity");
    if(role.role!=="backup"||role.backup_id!==manifest.backup_id||store.id!==manifest.store_id||vault.keyVersion!==manifest.key_version||vault.schemaVersion!==manifest.schema_version)
      fail("retention_changed","Archive role and manifest disagree");
  }finally{vault.close();}
  await shape(directory,files);
  const bytes=files.reduce((sum,file)=>sum+file.size,0);if(!Number.isSafeInteger(bytes))fail("retention_limit","Archive size exceeds the safe counter range");
  return {identity,manifest,files,bytes};
}
function itemMatches(a:Archive,actual:Awaited<ReturnType<typeof inspect>>){
  return same(a.identity,actual.identity)&&a.backup_id===actual.manifest.backup_id&&a.store_id===actual.manifest.store_id&&a.created_at===actual.manifest.created_at&&
    a.manifest_sha256===actual.files.find(f=>f.path==="manifest.json")!.sha256&&a.bytes===actual.bytes&&a.files===actual.files.length;
}
function validatePlan(plan:RetentionPlan,root:string,identity:Identity,serverId:string){
  if(plan?.format!=="immich-mcp-retention"||plan.version!==1||!validVersion(plan.id)||plan.server_id!==serverId||plan.root!==root||!same(plan.identity,identity)||
    !Number.isFinite(Date.parse(plan.created_at))||!Number.isSafeInteger(plan.keep)||plan.keep<1||plan.keep>ARCHIVE_LIMIT||!Array.isArray(plan.archives)||plan.archives.length>ARCHIVE_LIMIT)
    fail("invalid_retention","Invalid retention plan");
  const seenNames=new Set<string>(),seenIds=new Set<string>();
  for(const a of plan.archives){
    if(!safeName(a.name)||a.name.startsWith(".retention-")||seenNames.has(a.name.toLowerCase())||!validVersion(a.backup_id)||seenIds.has(a.backup_id)||!validVersion(a.store_id)||
      !a.identity||typeof a.identity.dev!=="string"||typeof a.identity.ino!=="string"||!Number.isFinite(Date.parse(a.created_at))||!/^[a-f0-9]{64}$/.test(a.manifest_sha256)||
      !Number.isSafeInteger(a.files)||a.files<4||!Number.isSafeInteger(a.bytes)||a.bytes<0||!["keep","delete"].includes(a.action))
      fail("invalid_retention","Invalid retention archive entry");
    seenNames.add(a.name.toLowerCase());seenIds.add(a.backup_id);
  }
  const sorted=[...plan.archives].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||a.name.localeCompare(b.name));
  for(let i=0;i<sorted.length;i++)if(sorted[i]!.action!==(i<plan.keep?"keep":"delete"))fail("invalid_retention","Retention actions do not preserve the newest backups");
}
export async function planBackupRetention(directory:string,keep:number,key:Buffer,serverId:string){
  if(key.length!==32)fail("invalid_key","Supply a 32-byte backup key");
  if(!Number.isSafeInteger(keep)||keep<1||keep>ARCHIVE_LIMIT)fail("retention_keep","Keep must be between 1 and "+ARCHIVE_LIMIT);
  const {root,identity}=await rootPath(directory),owner=await lock(root);
  try{
    const archives:Archive[]=[],skipped:RetentionPlan["skipped"]=[];
    for(const name of await names(root)){
      if(name.startsWith(".retention-owner.sqlite"))continue;
      if(archives.length+skipped.length>=ARCHIVE_LIMIT)fail("retention_limit","Backup collection exceeds the archive limit");
      try{
        if(!safeName(name)||name.startsWith(".retention-"))fail("retention_path","Not an ordinary backup directory");
        const actual=await inspect(join(root,name),key,serverId),m=actual.manifest;
        archives.push({name,identity:actual.identity,backup_id:m.backup_id!,store_id:m.store_id,created_at:m.created_at,
          manifest_sha256:actual.files.find(f=>f.path==="manifest.json")!.sha256,files:actual.files.length,bytes:actual.bytes,action:"keep"});
      }catch(error){skipped.push({name,code:error instanceof BridgeError?error.code:"unverified_backup"});}
    }
    const duplicates=new Set(archives.filter((a,i)=>archives.findIndex(b=>b.backup_id===a.backup_id)!==i).map(a=>a.backup_id));
    const collisions=new Set(archives.filter((a,i)=>archives.findIndex(b=>b.name.toLowerCase()===a.name.toLowerCase())!==i).map(a=>a.name.toLowerCase()));
    for(let i=archives.length-1;i>=0;i--){
      const a=archives[i]!;
      if(duplicates.has(a.backup_id)||collisions.has(a.name.toLowerCase()))skipped.push({name:archives.splice(i,1)[0]!.name,code:duplicates.has(a.backup_id)?"duplicate_backup_id":"case_colliding_archive"});
    }
    archives.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||a.name.localeCompare(b.name));
    archives.forEach((a,i)=>{a.action=i<keep?"keep":"delete";});
    const plan:RetentionPlan={format:"immich-mcp-retention",version:1,id:randomUUID(),server_id:serverId,root,identity,created_at:new Date().toISOString(),keep,archives,skipped};
    const document=seal(plan,key,serverId,"plan");if(Buffer.byteLength(JSON.stringify(document))>PLAN_LIMIT)fail("retention_limit","Retention plan exceeds its limit");
    return {plan,document};
  }finally{owner.close();}
}
export async function writeRetentionPlan(path:string,document:SealedRetention){
  if(!isAbsolute(path))fail("retention_path","Use an absolute new plan file");
  await writeFile(path,JSON.stringify(document)+"\n",{flag:"wx",mode:0o600,flush:true});await syncDirectory(dirname(path));
}
async function remaining(directory:string,archive:Archive,plan:RetentionPlan,key:Buffer,serverId:string){
  await sameDirectory(directory,archive.identity);
  const intentFile=join(directory,".retention-delete.json");
  if(!await exists(intentFile)){
    if((await names(directory)).length===0)return {empty:true as const};
    const actual=await inspect(directory,key,serverId);if(!itemMatches(archive,actual))fail("retention_changed","Deletion candidate changed");
    return {files:actual.files};
  }
  const intent=unseal<Intent>(await bounded(intentFile,INTENT_LIMIT),key,serverId,"delete");
  if(intent.format!=="immich-mcp-retention-delete"||intent.version!==1||intent.server_id!==serverId||intent.plan_id!==plan.id||!same(intent.root,plan.identity)||
    JSON.stringify(intent.archive)!==JSON.stringify(archive)||!Array.isArray(intent.files)||intent.files.length!==archive.files)
    fail("invalid_retention","Deletion intent does not match this plan");
  await shape(directory,intent.files,true,true);return {files:intent.files,intent:true};
}
export async function applyBackupRetention(directory:string,planFile:string,key:Buffer,serverId:string){
  const {root,identity}=await rootPath(directory),plan=unseal<RetentionPlan>(await bounded(planFile,PLAN_LIMIT),key,serverId,"plan");
  validatePlan(plan,root,identity,serverId);const owner=await lock(root);
  const quarantine=(a:Archive)=>join(root,".retention-deleting-"+plan.id+"-"+a.backup_id),kept=plan.archives.filter(a=>a.action==="keep");
  const checkKept=async()=>{for(const a of kept){const actual=await inspect(join(root,a.name),key,serverId);if(!itemMatches(a,actual))fail("retention_changed","A retained backup changed or disappeared");}};
  const removed:string[]=[],alreadyAbsent:string[]=[];
  try{
    await sameDirectory(root,identity);await checkKept();
    // Preflight the whole approved set before the first rename or unlink.
    for(const a of plan.archives.filter(a=>a.action==="delete")){
      const original=join(root,a.name),staged=quarantine(a);
      if(await exists(staged)){if(await exists(original))fail("retention_changed","Original and staged archive both exist");await remaining(staged,a,plan,key,serverId);}
      else if(await exists(original)){const actual=await inspect(original,key,serverId);if(!itemMatches(a,actual))fail("retention_changed","Deletion candidate changed");}
    }
    for(const a of plan.archives.filter(a=>a.action==="delete")){
      await sameDirectory(root,identity);await checkKept();
      const original=join(root,a.name),staged=quarantine(a);
      if(!await exists(staged)){
        if(!await exists(original)){alreadyAbsent.push(a.name);continue;}
        const actual=await inspect(original,key,serverId);if(!itemMatches(a,actual))fail("retention_changed","Deletion candidate changed");
        await sameDirectory(original,a.identity);await rename(original,staged);await syncDirectory(root);
      }
      const state=await remaining(staged,a,plan,key,serverId);
      if(!("empty" in state)){
        const files=state.files;
        if(!("intent" in state)){
          const intent:Intent={format:"immich-mcp-retention-delete",version:1,plan_id:plan.id,server_id:serverId,root:identity,archive:a,files};
          const document=JSON.stringify(seal(intent,key,serverId,"delete"))+"\n";
          if(Buffer.byteLength(document)>INTENT_LIMIT)fail("retention_limit","Deletion intent exceeds its limit");
          await writeFile(join(staged,".retention-delete.json"),document,{flag:"wx",mode:0o600,flush:true});await syncDirectory(staged);
        }
        await shape(staged,files,true,true);
        for(const file of [...files].sort((x,y)=>Number(y.path.startsWith("objects/"))-Number(x.path.startsWith("objects/")))){
          await sameDirectory(root,identity);await sameDirectory(staged,a.identity);
          const path=join(staged,file.path),rel=relative(staged,path);
          if(isAbsolute(rel)||rel.startsWith(".."+sep)||rel==="..")fail("retention_path","Deletion target escaped its archive");
          if(file.path.startsWith("objects/"))await sameDirectory(join(staged,"objects"),await directoryIdentity(join(staged,"objects")));
          if(!await exists(path))continue;
          const actual=await hashFile(path);if(actual.size!==file.size||actual.sha256!==file.sha256)fail("retention_changed","Deletion file changed");
          await unlink(path);
        }
        if(await exists(join(staged,"objects")))await rmdir(join(staged,"objects"));
        await sameDirectory(root,identity);await sameDirectory(staged,a.identity);
        // Never remove an extra entry that appeared while files were deleted.
        const rest=await names(staged);if(rest.length!==1||rest[0]!==".retention-delete.json")fail("retention_extra_files","Deletion directory contains an unexpected entry");
        const proof=await remaining(staged,a,plan,key,serverId);
        if(!("intent" in proof))fail("retention_changed","Deletion intent changed before final removal");
        await syncDirectory(staged);await unlink(join(staged,".retention-delete.json"));await syncDirectory(staged);
      }
      await sameDirectory(root,identity);await sameDirectory(staged,a.identity);await rmdir(staged);await syncDirectory(root);removed.push(a.name);
    }
    return {state:"retention_applied",plan_id:plan.id,removed,already_absent:alreadyAbsent,retained:kept.map(a=>a.name)};
  }finally{owner.close();}
}
