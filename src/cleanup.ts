import { opendir,unlink,stat } from "node:fs/promises";
import { join,resolve,dirname } from "node:path";
import type { Vault } from "./vault.js";
export interface CleanupOptions {now?:number;maxRecords?:number;orphanGraceMs?:number;signal?:AbortSignal;}
export interface CleanupReport {records_deleted:number;objects_deleted:number;orphan_objects_deleted:number;index_rows_deleted:number;active_skipped:number;failures:number;}
const rawName=/^raw_[0-9a-f-]{36}$/i;
function objectPath(vault:Vault,id:string){
  const directory=resolve(vault.directory,"objects"),path=resolve(directory,id);
  if(!rawName.test(id)||dirname(path)!==directory)throw Error("Invalid object identity");
  return path;
}
export async function cleanupVault(vault:Vault,options:CleanupOptions={}):Promise<CleanupReport>{
  const now=options.now ?? Date.now(),maxRecords=options.maxRecords ?? 2000,grace=options.orphanGraceMs ?? 300000;
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(maxRecords)||maxRecords<1||!Number.isSafeInteger(grace)||grace<0)throw Error("Invalid cleanup limits");
  const report:CleanupReport={records_deleted:0,objects_deleted:0,orphan_objects_deleted:0,index_rows_deleted:0,active_skipped:0,failures:0};
  const rows=vault.db.prepare("SELECT principal,id,kind FROM records WHERE expires<? ORDER BY expires,principal,id LIMIT ?").all(now,maxRecords) as {principal:string;id:string;kind:string}[];
  for(const row of rows){
    if(options.signal?.aborted)return report;
    if(vault.isPinned(row.principal,row.id)){report.active_skipped++;continue;}
    if(row.kind==="raw"){
      try{await unlink(objectPath(vault,row.id));report.objects_deleted++;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"){report.failures++;continue;}}
    }
    if(row.kind==="raw"){
      vault.storage.removeObject(row.id);
      vault.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND kind='raw' AND expires<?").run(row.principal,row.id,now);
      report.records_deleted++;
    }
    else report.records_deleted+=Number(vault.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND expires<?").run(row.principal,row.id,now).changes);
  }
  for(const row of vault.db.prepare("SELECT principal,id FROM raw_objects WHERE state='deleting' LIMIT ?").all(maxRecords) as {principal:string;id:string}[]){
    if(vault.isObjectActive(row.id))continue;
    try{await unlink(objectPath(vault,row.id));report.objects_deleted++;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"){report.failures++;continue;}}
    const existed=!!vault.db.prepare("SELECT 1 FROM records WHERE principal=? AND id=? AND kind='raw'").get(row.principal,row.id);
    vault.storage.removeObject(row.id);if(existed)report.records_deleted++;
  }
  for(const r of vault.db.prepare("SELECT principal,id FROM storage_reservations WHERE expires<? AND purpose<>'capture'").all(now) as {principal:string;id:string}[])
    if(!vault.isPinned(r.principal,r.id))vault.storage.release(r.principal,r.id);
  const credentials=vault.db.prepare("SELECT principal,id FROM records WHERE kind='credential' AND NOT EXISTS(SELECT 1 FROM bindings b WHERE b.principal=records.principal AND b.credential=records.id) LIMIT ?").all(maxRecords) as {principal:string;id:string}[];
  for(const row of credentials)if(!vault.isPinned(row.principal,row.id))
    report.records_deleted+=Number(vault.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND kind='credential'").run(row.principal,row.id).changes);
  const has=(name:string)=>!!vault.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  for(const table of ["result_pages","json_pages"])if(has(table))
    report.index_rows_deleted+=Number(vault.db.prepare("DELETE FROM "+table+" WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.principal="+table+".principal AND r.id="+table+".ref)").run().changes);
  if(has("jobs"))report.index_rows_deleted+=Number(vault.db.prepare("DELETE FROM jobs WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.principal=jobs.principal AND r.id=jobs.id AND r.kind='job')").run().changes);
  if(has("upload_chunks"))report.index_rows_deleted+=Number(vault.db.prepare("DELETE FROM upload_chunks WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.principal=upload_chunks.principal AND r.id=upload_chunks.raw_ref AND r.kind='raw')").run().changes);
  if(has("staging_usage"))report.index_rows_deleted+=Number(vault.db.prepare("DELETE FROM staging_usage WHERE expires<? AND NOT EXISTS(SELECT 1 FROM records r WHERE r.principal=staging_usage.principal AND r.id=staging_usage.id)").run(now).changes);
  if(has("oauth_states"))report.index_rows_deleted+=Number(vault.db.prepare("DELETE FROM oauth_states WHERE expires<?").run(now).changes);
  let entries;
  try{entries=await opendir(join(vault.directory,"objects"));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return report;throw error;}
  for await(const entry of entries){
    if(options.signal?.aborted)return report;
    if(!entry.isFile()||!rawName.test(entry.name))continue;
    if(vault.isObjectActive(entry.name)){report.active_skipped++;continue;}
    if(vault.db.prepare("SELECT 1 FROM records WHERE id=? AND kind='raw'").get(entry.name))continue;
    try{
      const path=objectPath(vault,entry.name);
      const info=await stat(path);vault.storage.observeOrphan(entry.name,info.size);
      if(info.mtimeMs>now-grace)continue;
      if(vault.isObjectActive(entry.name)||vault.db.prepare("SELECT 1 FROM records WHERE id=? AND kind='raw'").get(entry.name))continue;
      await unlink(path);vault.storage.removeObject(entry.name);report.orphan_objects_deleted++;
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")report.failures++;}
  }
  return report;
}
