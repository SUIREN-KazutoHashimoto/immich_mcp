import { createHash,randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { Staging,validateFile,type StagedFile } from "./staging.js";
import { BridgeError } from "./types.js";
export interface UploadStart {filename:string;mime:string;size:number;sha256?:string;}
interface UploadRecord extends UploadStart {revision:number;expires:number;offset:number;next:number;state:"open"|"completed"|"aborted";result?:StagedFile;digests?:{index:number;size:number;sha256:string}[];}
interface Chunk {sequence:number;raw_ref:string;size:number;sha256:string;}
export class Uploads {
  private active=new Set<string>();
  constructor(readonly staging:Staging,readonly chunkBytes=1024*1024) {
    if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>8*1024*1024)throw Error("Invalid upload chunk limit");
    this.vault.db.exec("CREATE TABLE IF NOT EXISTS upload_chunks(principal TEXT NOT NULL,upload TEXT NOT NULL,sequence INTEGER NOT NULL,raw_ref TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(principal,upload,sequence))");
  }
  get vault():Vault {return this.staging.vault;}
  private owned(principal:string,id:string,requireBinding=true):UploadRecord {
    const r=this.vault.get(principal,id,"upload") as UploadRecord;
    if(requireBinding && this.vault.resourceRevision(principal)!==r.revision)
      throw new BridgeError("invalid_reference","Upload binding has changed");
    return r;
  }
  private async lock<T>(principal:string,id:string,work:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([principal,id]);
    if(this.active.has(key))throw new BridgeError("upload_busy","Another upload operation is in progress");
    this.active.add(key);try{return await work();}finally{this.active.delete(key);}
  }
  start(principal:string,input:UploadStart) {
    if(!input || Object.keys(input).some(k=>!["filename","mime","size","sha256"].includes(k)))throw new BridgeError("invalid_upload","Unknown upload field");
    validateFile(input.filename,input.mime);
    if(!Number.isSafeInteger(input.size)||input.size<0||input.size>this.staging.maxFileBytes ||
      !Number.isSafeInteger(input.size*2) || Math.ceil(input.size/this.chunkBytes)>10000)throw new BridgeError("upload_size","Invalid upload size");
    if(input.sha256!==undefined && !/^[0-9a-f]{64}$/i.test(input.sha256))throw new BridgeError("file_hash","Invalid expected SHA-256");
    const revision=this.vault.resourceRevision(principal),id="upload_"+randomUUID(),expires=Date.now()+this.staging.ttlMs;
    this.staging.reserve(principal,id,expires,input.size*2,16384+Math.ceil(input.size/this.chunkBytes)*1024);
    try{this.vault.put(principal,"upload",{...input,revision,expires,offset:0,next:0,state:"open"},expires,id,id);}
    catch(error){this.vault.db.prepare("DELETE FROM staging_usage WHERE principal=? AND id=?").run(principal,id);this.vault.storage.release(principal,id);throw error;}
    return this.status(principal,id);
  }
  status(principal:string,id:string) {
    const r=this.owned(principal,id);
    return {upload_ref:id,state:r.state,file_name:r.filename,size:r.size,received_bytes:r.offset,
      next_chunk:r.next,chunk_bytes:this.chunkBytes,chunks:r.digests ?? this.chunks(principal,id).map(c=>({index:c.sequence,size:c.size,sha256:c.sha256})),expires_at:new Date(r.expires).toISOString(),file:r.result ?? null};
  }
  async append(principal:string,id:string,index:number,sha256:string,source:AsyncIterable<Uint8Array>) {
    return this.lock(principal,id,async()=>{
      const r=this.owned(principal,id);
      if(r.state!=="open" || !Number.isSafeInteger(index)||index<0 || index>r.next || !/^[a-f0-9]{64}$/i.test(sha256))
        throw new BridgeError("upload_order","Invalid upload state, chunk index or hash");
      if(index<r.next){
        const chunk=this.vault.db.prepare("SELECT * FROM upload_chunks WHERE principal=? AND upload=? AND sequence=?").get(principal,id,index) as unknown as Chunk|undefined;
        if(!chunk || chunk.sha256!==sha256.toLowerCase())throw new BridgeError("chunk_conflict","Previously accepted chunk differs");
        const hash=createHash("sha256");let size=0;
        for await(const bytes of source){size+=bytes.length;if(size>chunk.size)throw new BridgeError("chunk_size","Duplicate chunk size differs");hash.update(bytes);}
        if(size!==chunk.size || hash.digest("hex")!==chunk.sha256)throw new BridgeError("chunk_conflict","Duplicate chunk content differs");
        return this.status(principal,id);
      }
      const expected=Math.min(this.chunkBytes,r.size-r.offset);
      if(expected<=0)throw new BridgeError("upload_order","All declared bytes are already received");
      const raw=await this.vault.capture(principal,source,expected,undefined,r.expires,false,{bodyReservation:id,expectedBytes:expected});
      try{
        if(raw.size!==expected || raw.sha256!==sha256.toLowerCase())throw new BridgeError("chunk_hash","Chunk size or SHA-256 differs");
        if(this.vault.resourceRevision(principal)!==r.revision)throw new BridgeError("credential_conflict","Credential changed during upload");
        r.offset+=raw.size;r.next++;
        this.vault.db.exec("BEGIN IMMEDIATE");
        try{
          this.vault.db.prepare("INSERT INTO upload_chunks VALUES(?,?,?,?,?,?)").run(principal,id,index,raw.raw_ref,raw.size,raw.sha256);
          this.vault.put(principal,"upload",r,r.expires,id,id);this.vault.db.exec("COMMIT");
        }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
      }catch(error){await this.vault.removeRaw(principal,raw.raw_ref);throw error;}
      return this.status(principal,id);
    });
  }
  private chunks(principal:string,id:string) {
    return this.vault.db.prepare("SELECT sequence,raw_ref,size,sha256 FROM upload_chunks WHERE principal=? AND upload=? ORDER BY sequence").all(principal,id) as unknown as Chunk[];
  }
  private async releaseChunks(principal:string,id:string) {
    for(const chunk of this.chunks(principal,id)){
      try{await this.vault.removeRaw(principal,chunk.raw_ref);
        this.vault.db.prepare("DELETE FROM upload_chunks WHERE principal=? AND upload=? AND sequence=?").run(principal,id,chunk.sequence);
      }catch{/* Keep a cleanup record; completed-file delivery is independent of cleanup. */}
    }
  }
  async complete(principal:string,id:string) {
    return this.lock(principal,id,async()=>{
      const r=this.owned(principal,id);
      if(r.state==="completed"){
        await this.staging.file(principal,r.result!.file_ref);
        await this.releaseChunks(principal,id);return r.result!;
      }
      if(r.state!=="open" || r.offset!==r.size)throw new BridgeError("upload_incomplete","Upload has not received its declared bytes");
      const chunks=this.chunks(principal,id);
      if(chunks.length!==r.next || chunks.some((c,i)=>c.sequence!==i))throw new BridgeError("upload_incomplete","Upload chunk sequence is incomplete");
      const vault=this.vault;
      const source=async function*(){
        for(const chunk of chunks){
          const raw=vault.get(principal,chunk.raw_ref,"raw");
          if(raw.size!==chunk.size || raw.sha256!==chunk.sha256)throw new BridgeError("chunk_hash","Chunk metadata differs");
          yield* vault.rawStream(principal,chunk.raw_ref);
        }
      };
      const result=await this.staging.ingest(principal,r.filename,r.mime,source(),r.size,
        {id,expires:r.expires,onCommit:file=>{r.state="completed";r.digests=chunks.map(c=>({index:c.sequence,size:c.size,sha256:c.sha256}));r.result=file;this.vault.put(principal,"upload",r,r.expires,id,id);}},r.sha256);
      await this.releaseChunks(principal,id);return result;
    });
  }
  async abort(principal:string,id:string) {
    return this.lock(principal,id,async()=>{
      const r=this.owned(principal,id,false);
      if(r.state==="completed")return {upload_ref:id,state:r.state};
      this.vault.db.exec("BEGIN IMMEDIATE");
      try{
        r.state="aborted";this.vault.put(principal,"upload",r,r.expires,id,id);
        this.vault.db.prepare("DELETE FROM staging_usage WHERE principal=? AND id=?").run(principal,id);this.vault.storage.release(principal,id);this.vault.db.exec("COMMIT");
      }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
      await this.releaseChunks(principal,id);return {upload_ref:id,state:r.state};
    });
  }
}
