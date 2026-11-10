import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { BridgeError } from "./types.js";
import type { FilePart } from "./serializer.js";
import { DownloadPolicy } from "./download.js";
export interface StageInput {download_url:string;file_id:string;mime_type?:string;file_name?:string;}
export interface StagingOptions {maxFileBytes?:number;quotaBytes?:number;ttlMs?:number;}
export interface StagedFile {file_ref:string;file_name:string;mime_type:string;size:number;sha256:string;expires_at:string;}
export interface UploadClaim {id:string;expires:number;onCommit?:(file:StagedFile)=>void;}
export function validateFile(filename:string,mime:string) {
  if(typeof filename!=="string" || !filename || filename.length>512 || /[\r\n\0]/.test(filename) ||
    typeof mime!=="string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime))
    throw new BridgeError("invalid_file","Invalid display filename or MIME type");
}
export class Staging {
  readonly maxFileBytes:number;readonly quotaBytes:number;readonly ttlMs:number;
  constructor(readonly vault:Vault,readonly downloads:DownloadPolicy,options:StagingOptions={}) {
    this.maxFileBytes=options.maxFileBytes ?? 1024*1024*1024;
    this.quotaBytes=options.quotaBytes ?? 3*1024*1024*1024;
    this.ttlMs=options.ttlMs ?? 3600_000;
    for(const n of [this.maxFileBytes,this.quotaBytes,this.ttlMs])if(!Number.isSafeInteger(n)||n<=0)throw Error("Invalid staging limit");
    vault.db.exec("CREATE TABLE IF NOT EXISTS staging_usage(principal TEXT NOT NULL,id TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,id))");
  }
  reserve(principal:string,id:string,expires:number,requested?:number,metadataBytes=8192) {
    this.vault.db.exec("BEGIN IMMEDIATE");
    try{
      const used=this.vault.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM staging_usage WHERE principal=? AND expires>?").get(principal,Date.now()) as any;
      const limit=requested ?? Math.min(this.maxFileBytes,this.quotaBytes-used.n,Math.max(0,this.vault.storage.usage(principal).available_bytes-metadataBytes));
      if(!Number.isSafeInteger(limit) || limit<0 || limit>this.quotaBytes-used.n || requested===undefined && limit===0)throw new BridgeError("staging_quota","Staging quota exhausted");
      this.vault.storage.reserve(principal,id,limit+metadataBytes,id.startsWith("upload_")?"upload":"staging",expires);
      this.vault.db.prepare("INSERT INTO staging_usage VALUES(?,?,?,?)").run(principal,id,limit,expires);
      this.vault.db.exec("COMMIT");return limit;
    }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
  }
  async ingest(principal:string,filename:string,mime:string,source:AsyncIterable<Uint8Array>,expectedSize?:number,claim?:UploadClaim,expectedHash?:string):Promise<StagedFile> {
    const revision=this.vault.resourceRevision(principal);
    validateFile(filename,mime);
    if(expectedHash!==undefined && !/^[a-f0-9]{64}$/i.test(expectedHash))throw new BridgeError("file_hash","Invalid expected SHA-256");
    if(expectedSize!==undefined && (!Number.isSafeInteger(expectedSize)||expectedSize<0))throw new BridgeError("invalid_file","Invalid file size");
    const id="file_"+randomUUID(),expires=claim?.expires ?? Date.now()+this.ttlMs;
    const reserved=claim?this.vault.db.prepare("SELECT size,expires FROM staging_usage WHERE principal=? AND id=?").get(principal,claim.id) as any:undefined;
    if(claim && (!reserved || reserved.expires!==expires || expires<=Date.now()))throw new BridgeError("invalid_reference","Upload reservation unavailable");
    const limit=claim?Math.min(this.maxFileBytes,reserved.size):this.reserve(principal,id,expires);
    let raw:{raw_ref:string;size:number;sha256:string}|undefined;
    try{
      if(expectedSize!==undefined && expectedSize>limit)throw new BridgeError("staging_quota","File exceeds remaining staging quota");
      raw=await this.vault.capture(principal,source,limit,undefined,expires,false,{bodyReservation:claim?.id ?? id});
      if(expectedSize!==undefined && raw.size!==expectedSize)throw new BridgeError("file_size","Attachment size differs from declared length");
      if(this.vault.resourceRevision(principal)!==revision)throw new BridgeError("credential_conflict","Credential changed during staging");
      if(expectedHash && raw.sha256!==expectedHash.toLowerCase())throw new BridgeError("file_hash","Completed file SHA-256 mismatch");
      const result={file_ref:id,file_name:filename,mime_type:mime,size:raw.size,sha256:raw.sha256,expires_at:new Date(expires).toISOString()};
      this.vault.db.exec("BEGIN IMMEDIATE");
      try {
        this.vault.put(principal,"staged_file",{revision,filename,mime,raw},expires,id,claim?.id ?? id);
        const updated=this.vault.db.prepare("UPDATE staging_usage SET id=?,size=? WHERE principal=? AND id=?").run(id,raw.size,principal,claim?.id ?? id);
        if(updated.changes!==1)throw new BridgeError("invalid_reference","Staging reservation changed");
        claim?.onCommit?.(result);
        this.vault.storage.release(principal,claim?.id ?? id);
        this.vault.db.exec("COMMIT");
      }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
      return result;
    }catch(error){
      try{if(raw)await this.vault.removeRaw(principal,raw.raw_ref);}
      finally{if(!claim){
        this.vault.db.prepare("DELETE FROM staging_usage WHERE principal=? AND id=?").run(principal,id);
        this.vault.storage.release(principal,id);
      }}
      throw error;
    }
  }
  async stage(principal:string,files:StageInput[]) {
    if(!Array.isArray(files)||!files.length||files.length>20)throw new BridgeError("invalid_files","Expected 1 to 20 attachments");
    const results=[];
    for(const file of files){
      if(!file || typeof file.file_id!=="string" || !file.file_id || typeof file.download_url!=="string" ||
        Object.keys(file).some(k=>!["file_id","download_url","mime_type","file_name"].includes(k)))
        throw new BridgeError("invalid_files","Invalid attachment descriptor");
      this.vault.resourceRevision(principal);
      const response=await this.downloads.open(file.download_url);
      try{
        const result=await this.ingest(principal,file.file_name ?? "attachment",file.mime_type ?? response.mime?.split(";")[0]?.trim() ?? "application/octet-stream",response.body,response.length);
        results.push({file_id:file.file_id,...result});
      }finally{response.close();}
    }
    return {files:results};
  }
  async file(principal:string,ref:string):Promise<FilePart> {
    const record=this.vault.get(principal,ref,"staged_file");
    if(record.revision!==this.vault.resourceRevision(principal))throw new BridgeError("invalid_reference","Staged file binding has changed");
    // Authenticate the metadata before constructing the filesystem stream.
    this.vault.get(principal,record.raw.raw_ref,"raw");
    const validate=()=>{if(record.revision!==this.vault.resourceRevision(principal))throw new BridgeError("invalid_reference","Staged file binding changed before send");this.vault.get(principal,ref,"staged_file");};
    return {filename:record.filename,mime:record.mime,size:record.raw.size,validate,open:()=>{validate();return this.vault.rawStream(principal,record.raw.raw_ref);}};
  }
}
