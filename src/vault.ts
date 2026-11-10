import { DatabaseSync,backup } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, opendirSync, existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BridgeError } from "./types.js";
import { cleanupVault,type CleanupOptions,type CleanupReport } from "./cleanup.js";
import { StorageBudget,type StorageLimits } from "./storage.js";
import { openStorageOwner,readVaultSchema,migrateVault,type VaultSchema } from "./vault-schema.js";
import { vaultAad,encryptRecord,decryptRecord,validVersion,type CryptoFormat } from "./vault-crypto.js";

export class Vault {
  readonly db!:DatabaseSync;readonly storage!:StorageBudget;private owner!:DatabaseSync;
  private pins=new Map<string,number>();private objects=new Map<string,number>();
  private cleaning?:Promise<CleanupReport>;
  private allocationScope?:{principal:string;reservation:string};private schema!:VaultSchema;private closed=false;
  get schemaVersion(){return this.schema.version;}
  get keyVersion(){return this.schema.keyVersion;}
  withReservation<T>(principal:string,reservation:string,work:()=>T):T{
    const previous=this.allocationScope;this.allocationScope={principal,reservation};
    try{return work();}finally{this.allocationScope=previous;}
  }
  pin(principal:string,id:string){
    const key=JSON.stringify([principal,id]);this.pins.set(key,(this.pins.get(key) ?? 0)+1);
    const raw=/^raw_[0-9a-f-]{36}$/i.test(id);
    if(raw)this.objects.set(id,(this.objects.get(id) ?? 0)+1);
    let released=false;
    return ()=>{if(released)return;released=true;
      const count=this.pins.get(key)!-1;if(count)this.pins.set(key,count);else this.pins.delete(key);
      if(raw){const count=this.objects.get(id)!-1;if(count)this.objects.set(id,count);else this.objects.delete(id);}
    };
  }
  isPinned(principal:string,id:string){return this.pins.has(JSON.stringify([principal,id]));}
  isObjectActive(id:string){return this.objects.has(id);}
  cleanup(options:CleanupOptions={}){
    this.requireWritable();if(this.cleaning)return this.cleaning;
    this.cleaning=cleanupVault(this,options).finally(()=>{this.cleaning=undefined;});return this.cleaning;
  }
  constructor(readonly directory: string, private key: Buffer, readonly serverId: string, databasePath?: string,limits:StorageLimits={},private maintenance=false,private snapshotOnly=false) {
    if (key.length !== 32) throw Error("Vault requires an externally supplied 32-byte master key");
    if(snapshotOnly&&!maintenance)throw new BridgeError("maintenance_required","Snapshots require offline ownership");
    this.key=Buffer.from(key);
    if(!maintenance&&[".maintenance-incomplete",".backup-only"].some(name=>existsSync(join(directory,name))))throw new BridgeError("maintenance_incomplete","Storage is not an activated application generation");
    let owner:DatabaseSync|undefined,database:DatabaseSync|undefined;
    try {
    this.owner=owner=openStorageOwner(directory);
    this.db=database=new DatabaseSync(databasePath ?? join(directory,"vault.sqlite"),{readOnly:snapshotOnly});
    this.db.exec(snapshotOnly?"PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN;":"PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.schema=readVaultSchema(this.db,!snapshotOnly);
    const check = this.db.prepare("SELECT * FROM records WHERE principal=? AND id=?").get("__system","key_check") as any;
    if (check) {if(check.kind!=="check")throw Error("Invalid master-key check");this.decrypt("__system","key_check","check",check.payload,check.key_version);}
    else {
      if(snapshotOnly)throw Error("Vault master-key check missing");
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM records").get() as any;
      if (count.n) throw Error("Vault master-key check missing");
    }
    const role=this.db.prepare("SELECT * FROM records WHERE principal='__system' AND id='store_role'").get() as any;
    if(role){
      const value=this.decrypt("__system","store_role",role.kind,role.payload,role.key_version);
      if(role.kind!=="store_role"||value?.role!=="backup"||!validVersion(value.backup_id))throw new BridgeError("invalid_store_role","Invalid storage role");
      if(!snapshotOnly)throw new BridgeError("backup_only","Restore this backup to a new application directory before starting");
    }
    if(snapshotOnly){
      const identity=this.db.prepare("SELECT * FROM records WHERE principal='__system' AND id='store_identity'").get() as any;
      const bound=this.owner.prepare("SELECT store_id FROM owner_identity WHERE singleton=1").get() as any;
      const value=identity?this.decrypt("__system","store_identity",identity.kind,identity.payload,identity.key_version):undefined;
      if(identity&&(identity.kind!=="store_identity"||!validVersion(value?.id))||bound&&bound.store_id!==value?.id)
        throw new BridgeError("store_identity_mismatch","Database does not belong to this storage directory");
      return;
    }
    // Authenticate the key and storage role before changing the journal format.
    this.db.exec("PRAGMA journal_mode=WAL");
    this.bindStorageIdentity(!!check);
    this.schema=migrateVault(this.db,this.key,this.serverId,this.schema);
    this.storage=new StorageBudget(this.db,directory,limits,(principal,id,kind)=>{
      const row=this.db.prepare("SELECT * FROM records WHERE principal=? AND id=? AND kind=?").get(principal,id,kind) as any;
      if(!row)throw new BridgeError("invalid_reference","Stored record is unavailable");
      return this.decrypt(principal,id,kind,row.payload,row.key_version);
    });
    }catch(error){database?.close();owner?.close();this.key.fill(0);throw error;}
  }
  private bindStorageIdentity(hadKeyCheck:boolean) {
    const row=this.db.prepare("SELECT * FROM records WHERE principal='__system' AND id='store_identity'").get() as {kind:string;payload:Buffer;key_version?:string}|undefined;
    const identity=row?this.decrypt("__system","store_identity",row.kind,row.payload,row.key_version):undefined;
    const valid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if(row&&(row.kind!=="store_identity"||!valid(identity?.id)))throw new BridgeError("store_identity_mismatch","Invalid database storage identity");
    const bound=this.owner.prepare("SELECT store_id FROM owner_identity WHERE singleton=1").get() as {store_id:string}|undefined;
    if(bound){
      if(!valid(bound.store_id)||identity?.id!==bound.store_id)
        throw new BridgeError("store_identity_mismatch","Database does not belong to this storage directory");
      return;
    }
    // Any unbound root requires authenticated record IDs for every
    // generated object. A key check alone cannot prove which directory belongs
    // to a database when an operator has reused a master key.
    {
      let directory;
      try{directory=opendirSync(join(this.directory,"objects"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(directory)try{
        for(let entry;(entry=directory.readSync())!==null;)if(/^raw_[0-9a-f-]{36}$/i.test(entry.name)){
          if(!hadKeyCheck||!entry.isFile()||entry.isSymbolicLink())throw new BridgeError("store_identity_mismatch","Existing objects require their original database");
          const matches=this.db.prepare("SELECT * FROM records WHERE id=? AND kind='raw' LIMIT 2").all(entry.name) as any[];
          if(matches.length!==1)throw new BridgeError("store_identity_mismatch","Legacy objects require matching authenticated metadata");
          const row=matches[0];this.decrypt(row.principal,row.id,"raw",row.payload,row.key_version);
        }
      }finally{directory.closeSync();}
    }
    if(!hadKeyCheck)this.put("__system","check",{ok:true},Number.MAX_SAFE_INTEGER,"key_check");
    const id=identity?.id ?? randomUUID();
    // Commit the authenticated identity first. If startup stops between these
    // commits, the same database can safely finish binding the empty owner file.
    if(!identity)this.put("__system","store_identity",{id},Number.MAX_SAFE_INTEGER,"store_identity");
    this.owner.prepare("INSERT INTO owner_identity VALUES(1,?)").run(id);
  }
  private aad(principal:string,id:string,kind:string,format:CryptoFormat=this.schema.format) {
    return vaultAad(format,this.keyVersion,this.serverId,principal,id,kind);
  }
  private encrypt(principal:string,id:string,kind:string,data:any):Buffer {
    return encryptRecord(this.key,this.schema.format,this.keyVersion,this.serverId,principal,id,kind,data);
  }
  private decrypt(principal:string,id:string,kind:string,bytes:Uint8Array,keyVersion?:string):any {
    if(this.schema.version===2&&keyVersion!==this.keyVersion)throw new BridgeError("key_version_mismatch","Stored key version does not match this generation");
    return decryptRecord(this.key,this.schema.format,this.keyVersion,this.serverId,principal,id,kind,bytes);
  }
  put(principal:string,kind:string,data:any,expires=Date.now()+3600_000,id=kind+"_"+randomUUID(),reservation?:string) {
    this.requireWritable();const payload=this.encrypt(principal,id,kind,data);
    const write=()=>{
      if(this.schema.version===1)this.db.prepare("INSERT INTO records(principal,id,kind,payload,expires) VALUES(?,?,?,?,?) ON CONFLICT(principal,id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,expires=excluded.expires").run(principal,id,kind,payload,expires);
      else this.db.prepare("INSERT INTO records(principal,id,kind,payload,expires,key_version) VALUES(?,?,?,?,?,?) ON CONFLICT(principal,id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,expires=excluded.expires,key_version=excluded.key_version").run(principal,id,kind,payload,expires,this.keyVersion);
    };
    if(this.storage)this.storage.write(principal,id,payload,write,reservation ?? (this.allocationScope?.principal===principal?this.allocationScope.reservation:undefined));else write();
    return id;
  }
  get(principal:string,id:string,kind:string) {
    const row = this.db.prepare("SELECT * FROM records WHERE principal=? AND id=? AND kind=?").get(principal,id,kind) as any;
    if (!row || row.expires < Date.now()) throw new BridgeError("invalid_reference","Reference unavailable");
    return this.decrypt(principal,id,kind,row.payload,row.key_version);
  }
  binding(principal:string) {
    return this.db.prepare("SELECT revision,credential,key_id,state FROM bindings WHERE principal=?").get(principal) as
      {revision:number;credential:string|null;key_id:string|null;state:string}|undefined;
  }
  replaceBinding(principal:string,key:string,keyId:string,expectedRevision:number,reservation?:string,afterReplace?:(revision:number)=>void) {
    this.requireWritable();this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.binding(principal);
      if ((old?.revision ?? 0) !== expectedRevision) throw new BridgeError("credential_conflict","Binding revision changed");
      const revision = expectedRevision+1;
      const credential = this.put(principal,"credential",{key,revision},Number.MAX_SAFE_INTEGER,undefined,reservation);
      this.db.prepare("INSERT OR REPLACE INTO bindings VALUES(?,?,?,?,?)").run(principal,revision,credential,keyId,"active");
      // A rotation may commit its result/receipt together with the new key.
      afterReplace?.(revision);
      // Contexts and handles carry a revision and must be revalidated before use.
      this.db.exec("COMMIT");
      return revision;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  disconnect(principal:string,expectedRevision:number) {
    this.requireWritable();const row = this.db.prepare("UPDATE bindings SET credential=NULL,key_id=NULL,state='disconnected',revision=revision+1 WHERE principal=? AND revision=?").run(principal,expectedRevision);
    if (row.changes !== 1) throw new BridgeError("credential_conflict","Binding revision changed");
  }
  resourceRevision(principal:string) {return this.binding(principal)?.revision ?? 0;}
  credential(principal:string) {
    const b = this.binding(principal);
    if (!b || b.state !== "active" || !b.credential) throw new BridgeError("key_required","Register your API key in the control UI");
    const c = this.get(principal,b.credential,"credential");
    if (c.revision !== b.revision) throw new BridgeError("credential_conflict","Binding revision mismatch");
    return {key:c.key as string, revision:b.revision, keyId:b.key_id!};
  }
  async capture(principal:string,source:AsyncIterable<Uint8Array>,maxBytes:number,inspect?:(chunk:Uint8Array)=>void|Promise<void>,expires=Date.now()+3600_000,retainInterrupted=false,
    allocation:{bodyReservation?:string;metadataReservation?:string;expectedBytes?:number}={}) {
    this.requireWritable();if(!Number.isSafeInteger(maxBytes)||maxBytes<0||allocation.expectedBytes!==undefined&&(!Number.isSafeInteger(allocation.expectedBytes)||allocation.expectedBytes<0||allocation.expectedBytes>maxBytes))throw Error("Invalid capture limit");
    const id="raw_"+randomUUID(),metadata=allocation.metadataReservation ?? allocation.bodyReservation ?? "metadata_"+id;
    const ownMetadata=!allocation.metadataReservation&&!allocation.bodyReservation;
    let limit=this.storage.atomic(()=>{
      if(ownMetadata)this.storage.reserve(principal,metadata,1024,"raw_metadata",expires);
      return this.storage.beginObject(principal,id,maxBytes,expires,allocation.bodyReservation,allocation.expectedBytes);
    });
    const releases=[this.pin(principal,id),this.pin(principal,"capture_"+id),this.pin(principal,metadata)];
    if(allocation.bodyReservation)releases.push(this.pin(principal,allocation.bodyReservation));
    const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,nonce);cipher.setAAD(this.aad(principal,id,"raw"));
    const hash=createHash("sha256");let size=0,interrupted=false,interruption_code:string|undefined;
    const storage=this.storage;
    const counted=async function*(){
      try{
        for await(const chunk of source){
          for(let offset=0;offset<chunk.length;offset+=65536){
            const candidate=chunk.subarray(offset,Math.min(chunk.length,offset+65536));
            if(size+candidate.length>limit)limit=storage.extendObject(principal,id,Math.min(maxBytes,size+candidate.length),maxBytes);
            const accepted=Math.min(candidate.length,maxBytes-size,limit-size);
            if(accepted>0){
              const part=candidate.subarray(0,accepted);await inspect?.(part);size+=part.length;hash.update(part);yield part;
            }
            if(accepted<candidate.length){
              if(size>=maxBytes)throw new BridgeError("result_limit","Result exceeds configured storage limit");
              throw new BridgeError("storage_quota","Storage capacity is exhausted");
            }
          }
        }
      }catch(error){
        if(!retainInterrupted)throw error;
        interrupted=true;interruption_code=error instanceof BridgeError?error.code:"response_interrupted";
      }
    };
    const path=join(this.directory,"objects",id);
    try{
      await mkdir(join(this.directory,"objects"),{recursive:true});
      await pipeline(Readable.from(counted()),cipher,createWriteStream(path,{flags:"wx",mode:0o600,flush:true}));
      const sha256=hash.digest("hex");
      this.storage.atomic(()=>{
        this.storage.finishObject(principal,id,size);
        this.put(principal,"raw",{nonce:nonce.toString("hex"),tag:cipher.getAuthTag().toString("hex"),size,sha256,transfer_complete:!interrupted,interruption_code,crypto:{format:this.schema.format,key_version:this.keyVersion}},expires,id,metadata);
      });
      return {raw_ref:id,size,sha256,interrupted,interruption_code};
    }catch(error){
      let removed=false;
      try{await unlink(path);removed=true;}catch(failure){if((failure as NodeJS.ErrnoException).code==="ENOENT")removed=true;}
      if(removed)this.storage.removeObject(id);else this.storage.abandonObject(id);
      throw error;
    }finally{
      if(ownMetadata)this.storage.release(principal,metadata);
      for(const release of releases)release();
    }
  }
  rawStream(principal:string,id:string) {return this.openRaw(principal,id,false);}
  private openRaw(principal:string,id:string,expired:boolean) {
    const meta=expired?this.readStored(principal,id,"raw"):this.get(principal,id,"raw");
    const crypto=meta.crypto ?? (this.snapshotOnly&&this.schema.version===1?{format:1,key_version:"legacy"}:undefined);
    if(!crypto||![1,2].includes(crypto.format)||crypto.key_version!==this.keyVersion)throw new BridgeError("key_version_mismatch","Original encryption metadata does not match this generation");
    const d = createDecipheriv("aes-256-gcm",this.key,Buffer.from(meta.nonce,"hex"));
    d.setAAD(this.aad(principal,id,"raw",crypto.format)); d.setAuthTag(Buffer.from(meta.tag,"hex"));
    const release=this.pin(principal,id),source=createReadStream(join(this.directory,"objects",id)),decoded=source.pipe(d);
    source.on("error",error=>decoded.destroy(error));
    decoded.once("close",()=>source.destroy());
    decoded.on("error",()=>{});
    const output=Readable.from((async function*(){
      try{for await(const chunk of decoded)yield chunk;}finally{decoded.destroy();release();}
    })());
    output.once("close",()=>{decoded.destroy();release();});return output;
  }
  async removeRaw(principal:string,id:string) {
    this.requireWritable();
    if(!/^raw_[0-9a-f-]{36}$/i.test(id))throw new BridgeError("invalid_reference","Invalid raw reference");
    this.get(principal,id,"raw");
    if(this.isPinned(principal,id))throw new BridgeError("object_in_use","Object is in use");
    const row=this.storage.object(id);
    if(row&&row.principal!==principal)throw new BridgeError("invalid_reference","Object is unavailable");
    this.db.prepare("UPDATE raw_objects SET state='deleting' WHERE id=? AND principal=?").run(id,principal);
    await unlink(join(this.directory,"objects",id)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;});
    this.storage.removeObject(id);
    this.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND kind='raw'").run(principal,id);
  }
  matchesMasterKey(candidate:Buffer){return candidate.length===32&&timingSafeEqual(this.key,candidate);}
  health(){
    const state:{database:"ok"|"error";migration:"ok"|"error";encryption:"ok"|"error";ownership:"ok"|"error"}={database:"error",migration:"error",encryption:"error",ownership:"error"};
    if(this.closed)return state;
    try{
      this.db.exec("SAVEPOINT readiness_probe");
      try{
        const count=this.db.prepare("UPDATE storage_global SET bytes=bytes WHERE id=1").run();
        const row=this.db.prepare("SELECT bytes FROM storage_global WHERE id=1").get() as any;
        if(count.changes===1&&row&&Number.isSafeInteger(row.bytes)&&row.bytes>=0)state.database="ok";
      }
      finally{this.db.exec("ROLLBACK TO readiness_probe;RELEASE readiness_probe");}
    }catch{}
    try{
      const versions=this.db.prepare("SELECT version FROM schema_version").all(),crypto=this.db.prepare("SELECT singleton,format,key_version FROM vault_crypto").all();
      if(versions.length===1&&versions[0]!.version===2&&crypto.length===1&&crypto[0]!.singleton===1&&crypto[0]!.format===2&&crypto[0]!.key_version===this.keyVersion)
        state.migration="ok";
    }catch{}
    try{
      const row=this.db.prepare("SELECT * FROM records WHERE principal='__system' AND id='key_check' AND kind='check'").get() as any;
      if(row&&this.decrypt("__system","key_check","check",row.payload,row.key_version).ok===true)state.encryption="ok";
    }catch{}
    try{
      const row=this.db.prepare("SELECT * FROM records WHERE principal='__system' AND id='store_identity' AND kind='store_identity'").get() as any;
      const owner=this.owner.prepare("SELECT store_id FROM owner_identity WHERE singleton=1").get() as any;
      const versions=this.owner.prepare("SELECT version FROM ownership").all();
      if(row&&owner&&validVersion(owner.store_id)&&versions.length===1&&versions[0]!.version===1&&this.decrypt("__system","store_identity","store_identity",row.payload,row.key_version).id===owner.store_id)state.ownership="ok";
    }catch{}
    return state;
  }
  private requireWritable(){if(this.snapshotOnly)throw new BridgeError("snapshot_readonly","Offline snapshots cannot change application data");}
  private requireMaintenance(){
    if(!this.maintenance)throw new BridgeError("maintenance_required","Offline maintenance ownership is required");
  }
  readStored(principal:string,id:string,kind:string){
    this.requireMaintenance();const row=this.db.prepare("SELECT * FROM records WHERE principal=? AND id=? AND kind=?").get(principal,id,kind) as any;
    if(!row)throw new BridgeError("invalid_reference","Stored record is unavailable");
    return this.decrypt(principal,id,kind,row.payload,row.key_version);
  }
  storedRawStream(principal:string,id:string){this.requireMaintenance();return this.openRaw(principal,id,true);}
  async snapshotMain(destination:string){
    this.requireMaintenance();if(this.pins.size||this.cleaning)throw new BridgeError("store_busy","Storage still has active operations");
    await backup(this.db,destination);
  }
  async snapshotOwner(destination:string){
    this.requireMaintenance();if(this.pins.size||this.cleaning)throw new BridgeError("store_busy","Storage still has active operations");
    await backup(this.owner,destination);
  }
  async snapshotDatabases(main:string,owner:string){
    this.requireMaintenance();if(this.pins.size||this.cleaning)throw new BridgeError("store_busy","Storage still has active operations");
    await backup(this.db,main);await backup(this.owner,owner);
  }
  close() {if(this.closed)return;if(this.pins.size||this.cleaning)throw new BridgeError("store_busy","Storage still has active operations");if(this.db.isTransaction)this.db.exec("ROLLBACK");this.db.close();this.owner.close();this.key.fill(0);this.closed=true;}
}
