import { parseArgs } from "node:util";
import { readFile,realpath,lstat } from "node:fs/promises";
import { isAbsolute,resolve,join,relative,sep,dirname,basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { rekeyVault,type VaultLocation } from "../src/vault-rekey.js";
import { verifyGenerationManifest } from "../src/vault-manifest.js";
import { backupVault,restoreVault } from "../src/vault-backup.js";
import { planBackupRetention,writeRetentionPlan,applyBackupRetention } from "../src/vault-retention.js";
import { BridgeError } from "../src/types.js";
export function maintenanceServer(env:NodeJS.ProcessEnv=process.env){
  if(!env.IMMICH_BASE_URL)throw new BridgeError("configuration_required","IMMICH_BASE_URL is required");
  const upstream=new URL(env.IMMICH_BASE_URL);
  if(!["http:","https:"].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash||upstream.pathname.replace(/\/$/,"")!=="/api")
    throw new BridgeError("invalid_configuration","Use the fixed Immich origin plus /api");
  return createHash("sha256").update(upstream.toString().replace(/\/$/,"")).digest("hex");
}
async function separateKey(file:string,directory:string){
  const [keyPath,root]=await Promise.all([realpath(file),realpath(directory)]),rel=relative(root,keyPath);
  if(rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel))throw new BridgeError("key_not_separate","Keep the master key outside the data and backup directories");
  const info=await lstat(keyPath);if(!info.isFile()||info.size!==32)throw new BridgeError("invalid_key","Expected a 32-byte master-key file");
  const key=await readFile(keyPath);if(key.length!==32){key.fill(0);throw new BridgeError("invalid_key","Expected a 32-byte master-key file");}return key;
}
export async function maintenanceLocation(env:NodeJS.ProcessEnv=process.env):Promise<VaultLocation>{
  const serverId=maintenanceServer(env),directory=resolve(env.STORAGE_PATH ?? "./data");
  if(env.DATABASE_PATH===":memory:")throw new BridgeError("invalid_configuration","Offline maintenance requires a persistent database");
  if(!env.VAULT_MASTER_KEY_FILE)throw new BridgeError("configuration_required","VAULT_MASTER_KEY_FILE is required");
  const key=await separateKey(env.VAULT_MASTER_KEY_FILE,directory);
  return {directory,databasePath:resolve(env.DATABASE_PATH ?? join(directory,"vault.sqlite")),key,serverId};
}
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{to:{type:"string"},from:{type:"string"},"new-key":{type:"string"},directory:{type:"string"},key:{type:"string"},keep:{type:"string"},out:{type:"string"},plan:{type:"string"}}});
  if(positionals.length!==1)throw new BridgeError("usage","Expected backup, restore, rekey, verify, retention-plan or retention-apply");
  let location:VaultLocation|undefined,supplied:Buffer|undefined;
  try{
    if(positionals[0]==="retention-plan"){
      if(!values.directory||!values.key||!values.keep||!values.out||Object.keys(values).some(k=>!["directory","key","keep","out"].includes(k))||
        !isAbsolute(values.directory)||!isAbsolute(values.key)||!isAbsolute(values.out)||!/^\d+$/.test(values.keep))
        throw new BridgeError("usage","Use retention-plan --directory ABSOLUTE_BACKUP_ROOT --keep N --key ABSOLUTE_KEY_FILE --out ABSOLUTE_NEW_PLAN_FILE");
      const root=await realpath(values.directory),output=join(await realpath(dirname(resolve(values.out))),basename(values.out)),rel=relative(root,output);
      if(rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel))throw new BridgeError("retention_path","Keep the plan file outside the backup collection");
      supplied=await separateKey(values.key,root);
      const result=await planBackupRetention(root,Number(values.keep),supplied,maintenanceServer());await writeRetentionPlan(output,result.document);
      console.log(JSON.stringify({state:"retention_planned",plan_file:output,...result.plan}));return;
    }
    if(positionals[0]==="retention-apply"){
      if(!values.directory||!values.key||!values.plan||Object.keys(values).some(k=>!["directory","key","plan"].includes(k))||
        !isAbsolute(values.directory)||!isAbsolute(values.key)||!isAbsolute(values.plan))
        throw new BridgeError("usage","Use retention-apply --directory ABSOLUTE_BACKUP_ROOT --plan ABSOLUTE_PLAN_FILE --key ABSOLUTE_KEY_FILE");
      supplied=await separateKey(values.key,values.directory);
      console.log(JSON.stringify(await applyBackupRetention(values.directory,values.plan,supplied,maintenanceServer())));return;
    }
    if(positionals[0]==="backup"){
      if(!values.to||Object.keys(values).some(k=>k!=="to"))throw new BridgeError("usage","Use backup --to ABSOLUTE_NEW_DIRECTORY");
      location=await maintenanceLocation();console.log(JSON.stringify(await backupVault(location,values.to)));return;
    }
    if(positionals[0]==="restore"){
      if(!values.from||!values.to||!values.key||Object.keys(values).some(k=>!["from","to","key"].includes(k))||!isAbsolute(values.from)||!isAbsolute(values.key))
        throw new BridgeError("usage","Use restore --from ABSOLUTE_BACKUP --to ABSOLUTE_NEW_DIRECTORY --key ABSOLUTE_BACKUP_KEY_FILE");
      supplied=await separateKey(values.key,values.from);console.log(JSON.stringify(await restoreVault(values.from,values.to,supplied,maintenanceServer())));return;
    }
    if(positionals[0]==="rekey"){
      if(!values.to||!values["new-key"]||Object.keys(values).some(k=>!["to","new-key"].includes(k))||!isAbsolute(values["new-key"]))
        throw new BridgeError("usage","Use rekey --to ABSOLUTE_NEW_DIRECTORY --new-key ABSOLUTE_KEY_FILE");
      location=await maintenanceLocation();supplied=await readFile(values["new-key"]);console.log(JSON.stringify(await rekeyVault(location,values.to,supplied)));return;
    }
    if(positionals[0]==="verify"){
      if(!values.directory||!values.key||Object.keys(values).some(k=>!["directory","key"].includes(k))||!isAbsolute(values.directory)||!isAbsolute(values.key))
        throw new BridgeError("usage","Use verify --directory ABSOLUTE_DIRECTORY --key ABSOLUTE_KEY_FILE");
      supplied=await readFile(values.key);if(supplied.length!==32)throw new BridgeError("invalid_key","Expected a 32-byte key file");
      const manifest=await verifyGenerationManifest(values.directory,supplied,maintenanceServer());
      console.log(JSON.stringify({state:"verified",schema_version:manifest.schema_version,key_version:manifest.key_version,store_id:manifest.store_id,files:manifest.files.length}));return;
    }
    throw new BridgeError("usage","Expected backup, restore, rekey, verify, retention-plan or retention-apply");
  }finally{location?.key.fill(0);supplied?.fill(0);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{console.error(JSON.stringify({error:{code:error instanceof BridgeError?error.code:"maintenance_failed"}}));process.exitCode=1;});
}
