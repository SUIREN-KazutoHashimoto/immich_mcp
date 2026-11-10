import { lstat,open,readFile,unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Vault } from "./vault.js";
export interface LocalReadiness {
  database:"ok"|"error";migration:"ok"|"error";master_key:"ok"|"error";storage:"ok"|"error";registry:"ok"|"error";checked_at:string;
}
export const localReady=(state:LocalReadiness)=>[state.database,state.migration,state.master_key,state.storage,state.registry].every(s=>s==="ok");
export async function inspectLocal(vault:Vault,keyFile:string|undefined,integrity:()=>Promise<"ok"|"error">):Promise<LocalReadiness>{
  const checks=vault.health();
  let master_key=checks.encryption,storage:LocalReadiness["storage"]="error",registry:LocalReadiness["registry"]="error";
  if(keyFile){
    let bytes:Buffer|undefined;
    try{
      const info=await lstat(keyFile);if(!info.isFile()||info.isSymbolicLink()||info.size!==32)throw Error();
      bytes=await readFile(keyFile);if(!vault.matchesMasterKey(bytes))throw Error();
    }catch{master_key="error";}finally{bytes?.fill(0);}
  }
  const probe=join(vault.directory,".readiness-"+randomUUID());let created=false,handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const info=await lstat(vault.directory);if(!info.isDirectory()||info.isSymbolicLink()||checks.ownership!=="ok")throw Error();
    handle=await open(probe,"wx",0o600);created=true;await handle.writeFile("immich-mcp readiness\n");await handle.sync();await handle.close();handle=undefined;
    await unlink(probe);created=false;storage="ok";
  }catch{}finally{
    await handle?.close().catch(()=>{});
    if(created)await unlink(probe).catch(()=>{});
  }
  try{registry=await integrity();}catch{}
  return {database:checks.database,migration:checks.migration,master_key,storage,registry,checked_at:new Date().toISOString()};
}
