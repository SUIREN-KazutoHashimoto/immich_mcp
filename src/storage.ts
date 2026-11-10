import { opendirSync,statSync } from "node:fs";
import { resolve,dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BridgeError } from "./types.js";
export interface StorageLimits {quotaBytes?:number;globalQuotaBytes?:number;}
type Reservation={id:string;remaining:number;purpose:string;expires:number;parent:string|null};
type ObjectRow={principal:string;id:string;size:number;expires:number;parent:string|null;hold:string|null;state:string};
export class StorageBudget {
  readonly quotaBytes:number;readonly globalQuotaBytes:number;private sequence=0;
  constructor(readonly db:DatabaseSync,readonly directory:string,limits:StorageLimits,readonly read:(p:string,id:string,kind:string)=>any){
    this.quotaBytes=limits.quotaBytes ?? Number.MAX_SAFE_INTEGER;this.globalQuotaBytes=limits.globalQuotaBytes ?? Number.MAX_SAFE_INTEGER;
    for(const n of [this.quotaBytes,this.globalQuotaBytes])if(!Number.isSafeInteger(n)||n<1)throw Error("Invalid storage quota");
    const fresh=!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_schema'").get();
    if(!fresh){const versions=db.prepare("SELECT version FROM storage_schema").all() as {version:number}[];if(versions.length!==1||versions[0]!.version!==1)throw Error("Unsupported storage schema");}
    this.atomic(()=>{
      db.exec("CREATE TABLE IF NOT EXISTS storage_schema(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO storage_schema VALUES(1);"+
        "CREATE TABLE IF NOT EXISTS storage_totals(principal TEXT PRIMARY KEY,bytes INTEGER NOT NULL);"+
        "CREATE TABLE IF NOT EXISTS storage_global(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL);INSERT OR IGNORE INTO storage_global VALUES(1,0);"+
        "CREATE TABLE IF NOT EXISTS storage_reservations(principal TEXT NOT NULL,id TEXT NOT NULL,remaining INTEGER NOT NULL,purpose TEXT NOT NULL,expires INTEGER NOT NULL,parent TEXT,PRIMARY KEY(principal,id));"+
        "CREATE TABLE IF NOT EXISTS raw_objects(principal TEXT NOT NULL,id TEXT PRIMARY KEY,size INTEGER NOT NULL,expires INTEGER NOT NULL,parent TEXT,hold TEXT,state TEXT NOT NULL);");
      for(const [table,size] of [["records","length(NEW.payload)"],["raw_objects","NEW.size"],["storage_reservations","NEW.remaining"]] as const){
        const old=size.replaceAll("NEW.","OLD.");
        db.exec("CREATE TRIGGER IF NOT EXISTS "+table+"_quota_insert AFTER INSERT ON "+table+" BEGIN "+
          "INSERT INTO storage_totals VALUES(NEW.principal,"+size+") ON CONFLICT(principal) DO UPDATE SET bytes=bytes+excluded.bytes;"+
          "UPDATE storage_global SET bytes=bytes+"+size+" WHERE id=1;END;"+
          "CREATE TRIGGER IF NOT EXISTS "+table+"_quota_delete AFTER DELETE ON "+table+" BEGIN "+
          "UPDATE storage_totals SET bytes=bytes-"+old+" WHERE principal=OLD.principal;"+
          "UPDATE storage_global SET bytes=bytes-"+old+" WHERE id=1;END;"+
          "CREATE TRIGGER IF NOT EXISTS "+table+"_quota_update AFTER UPDATE ON "+table+" BEGIN "+
          "UPDATE storage_totals SET bytes=bytes-"+old+" WHERE principal=OLD.principal;"+
          "INSERT INTO storage_totals VALUES(NEW.principal,"+size+") ON CONFLICT(principal) DO UPDATE SET bytes=bytes+excluded.bytes;"+
          "UPDATE storage_global SET bytes=bytes+"+size+"-"+old+" WHERE id=1;END;");
      }
      this.rebuild();
      this.reconcile(fresh);
      this.rebuild();
    });
  }
  atomic<T>(work:()=>T):T{
    const name="storage_"+(++this.sequence);this.db.exec("SAVEPOINT "+name);
    try{const result=work();this.db.exec("RELEASE "+name);return result;}
    catch(error){this.db.exec("ROLLBACK TO "+name+";RELEASE "+name);throw error;}
  }
  private rebuild(){
    this.db.exec("DELETE FROM storage_totals;INSERT INTO storage_totals SELECT principal,SUM(n) FROM ("+
      "SELECT principal,length(payload) n FROM records UNION ALL SELECT principal,size n FROM raw_objects UNION ALL SELECT principal,remaining n FROM storage_reservations) GROUP BY principal;"+
      "UPDATE storage_global SET bytes=(SELECT COALESCE(SUM(bytes),0) FROM storage_totals) WHERE id=1;");
  }
  usage(principal:string){
    const used=Number((this.db.prepare("SELECT bytes FROM storage_totals WHERE principal=?").get(principal) as any)?.bytes ?? 0);
    const total=Number((this.db.prepare("SELECT bytes FROM storage_global WHERE id=1").get() as any).bytes);
    return {used_bytes:used,quota_bytes:this.quotaBytes,available_bytes:Math.max(0,Math.min(this.quotaBytes-used,this.globalQuotaBytes-total))};
  }
  private assert(principal:string,bytes:number){
    if(!Number.isSafeInteger(bytes)||bytes<0)throw Error("Invalid storage allocation");
    if(bytes>this.usage(principal).available_bytes)throw new BridgeError("storage_quota","Storage capacity is exhausted");
  }
  reservation(principal:string,id:string):Reservation|undefined{
    return this.db.prepare("SELECT id,remaining,purpose,expires,parent FROM storage_reservations WHERE principal=? AND id=?").get(principal,id) as Reservation|undefined;
  }
  reserve(principal:string,id:string,bytes:number,purpose:string,expires:number,parent?:string){
    if(!Number.isSafeInteger(bytes)||bytes<0)throw Error("Invalid storage reservation");
    this.atomic(()=>{
      if(parent){
        const r=this.reservation(principal,parent);
        if(!r||r.remaining<bytes)throw new BridgeError("storage_quota","Reserved storage capacity is unavailable");
        this.db.prepare("UPDATE storage_reservations SET remaining=remaining-? WHERE principal=? AND id=?").run(bytes,principal,parent);
      }else this.assert(principal,bytes);
      this.db.prepare("INSERT INTO storage_reservations VALUES(?,?,?,?,?,?)").run(principal,id,bytes,purpose,expires,parent ?? null);
    });
    return id;
  }
  release(principal:string,id:string,refund=true){
    const r=this.reservation(principal,id);if(!r)return;
    this.atomic(()=>{
      this.db.prepare("DELETE FROM storage_reservations WHERE principal=? AND id=?").run(principal,id);
      if(refund&&r.parent)this.refund(principal,r.parent,r.remaining);
    });
  }
  private refund(principal:string,id:string,bytes:number){
    const r=this.reservation(principal,id);
    if(r&&r.expires>=Date.now())this.db.prepare("UPDATE storage_reservations SET remaining=remaining+? WHERE principal=? AND id=?").run(bytes,principal,id);
  }
  private spend(principal:string,id:string|undefined,bytes:number){
    const r=id?this.reservation(principal,id):undefined;
    const fromReservation=Math.min(r?.remaining ?? 0,bytes);
    this.assert(principal,bytes-fromReservation);
    if(fromReservation)this.db.prepare("UPDATE storage_reservations SET remaining=remaining-? WHERE principal=? AND id=?").run(fromReservation,principal,id!);
  }
  write(principal:string,id:string,payload:Buffer,write:()=>void,reservation?:string){
    this.atomic(()=>{
      const old=Number((this.db.prepare("SELECT length(payload) n FROM records WHERE principal=? AND id=?").get(principal,id) as any)?.n ?? 0);
      this.spend(principal,reservation,Math.max(0,payload.length-old));write();
    });
  }
  beginObject(principal:string,id:string,maxBytes:number,expires:number,parent?:string,expectedBytes?:number){
    return this.atomic(()=>{
      const available=parent?Math.max(0,(this.reservation(principal,parent)?.remaining ?? 0)-(expectedBytes===undefined?2048:0)):this.usage(principal).available_bytes;
      const step=Math.max(65536,Math.min(64*1024*1024,Math.floor(available/8)));
      const holdBytes=Math.min(maxBytes,expectedBytes ?? (parent?available:Math.min(available,step)));
      if(expectedBytes!==undefined&&expectedBytes>available)throw new BridgeError("storage_quota","Reserved storage capacity is unavailable");
      if(holdBytes<0||!Number.isSafeInteger(holdBytes))throw Error("Invalid capture allocation");
      const hold="capture_"+id;
      this.reserve(principal,hold,holdBytes,"capture",expires,parent);
      this.db.prepare("INSERT INTO raw_objects VALUES(?,?,?,?,?,?,?)").run(principal,id,0,expires,parent ?? null,hold,"capturing");
      return holdBytes;
    });
  }
  extendObject(principal:string,id:string,wanted:number,maxBytes:number){
    const row=this.object(id),hold=row?.hold?this.reservation(principal,row.hold):undefined;
    if(!row||row.principal!==principal||!hold)throw new BridgeError("invalid_reference","Capture allocation unavailable");
    if(wanted<=hold.remaining)return hold.remaining;
    return this.atomic(()=>{
      const available=hold.parent?Math.max(0,(this.reservation(principal,hold.parent)?.remaining ?? 0)-2048):this.usage(principal).available_bytes;
      const step=Math.max(65536,Math.min(64*1024*1024,Math.floor(available/8)));
      const extra=Math.max(0,Math.min(available,maxBytes-hold.remaining,Math.max(wanted-hold.remaining,step)));
      if(hold.parent)this.db.prepare("UPDATE storage_reservations SET remaining=remaining-? WHERE principal=? AND id=?").run(extra,principal,hold.parent);
      else this.assert(principal,extra);
      this.db.prepare("UPDATE storage_reservations SET remaining=remaining+? WHERE principal=? AND id=?").run(extra,principal,hold.id);
      return hold.remaining+extra;
    });
  }
  finishObject(principal:string,id:string,bytes:number){
    const row=this.object(id);
    if(!row||row.principal!==principal||!row.hold)throw new BridgeError("invalid_reference","Capture allocation unavailable");
    const hold=row.hold;
    this.atomic(()=>{
      this.spend(principal,hold,bytes);
      this.db.prepare("UPDATE raw_objects SET size=?,hold=NULL,state='complete' WHERE id=? AND principal=?").run(bytes,id,principal);
      this.release(principal,hold);
    });
  }
  observeOrphan(id:string,size:number){
    const row=this.object(id);
    if(!row)this.db.prepare("INSERT INTO raw_objects VALUES('__orphan',?,?,0,NULL,NULL,'orphan')").run(id,size);
    else if(!row.hold)this.db.prepare("UPDATE raw_objects SET size=? WHERE id=?").run(size,id);
  }
  object(id:string){return this.db.prepare("SELECT * FROM raw_objects WHERE id=?").get(id) as ObjectRow|undefined;}
  removeObject(id:string){
    const row=this.object(id);if(!row)return;
    this.atomic(()=>{
      const record=Number((this.db.prepare("SELECT length(payload) n FROM records WHERE principal=? AND id=? AND kind='raw'").get(row.principal,id) as any)?.n ?? 0);
      this.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND kind='raw'").run(row.principal,id);
      this.db.prepare("DELETE FROM raw_objects WHERE id=?").run(id);
      if(row.hold)this.release(row.principal,row.hold);
      if(row.parent)this.refund(row.principal,row.parent,row.size+record);
    });
  }
  abandonObject(id:string){this.db.prepare("UPDATE raw_objects SET state='orphan' WHERE id=?").run(id);}
  private reconcile(fresh:boolean){
    const raw=this.db.prepare("SELECT principal,id,expires FROM records WHERE kind='raw'").all() as {principal:string;id:string;expires:number}[];
    const owned=new Map<string,(typeof raw)[number]>();
    for(const row of raw){
      if(!/^raw_[0-9a-f-]{36}$/i.test(row.id)||owned.has(row.id))throw Error("Conflicting object identity");
      owned.set(row.id,row);
    }
    const directory=resolve(this.directory,"objects"),seen=new Set<string>();
    let dir;
    try{dir=opendirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(dir)try{
      for(let entry;(entry=dir.readSync())!==null;){
        if(!entry.isFile()||!/^raw_[0-9a-f-]{36}$/i.test(entry.name))continue;
        const path=resolve(directory,entry.name);if(dirname(path)!==directory)throw Error("Invalid object path");
        const info=statSync(path),existing=this.object(entry.name),record=owned.get(entry.name);
        const principal=existing?.principal ?? record?.principal ?? "__orphan";
        if(existing&&record&&record.principal!==principal)throw Error("Conflicting object ownership");
        if(existing?.hold){
          const held=this.reservation(principal,existing.hold);
          if(held)this.db.prepare("UPDATE storage_reservations SET remaining=MAX(0,remaining-?) WHERE principal=? AND id=?").run(info.size,principal,held.id);
        }
        this.db.prepare("INSERT INTO raw_objects VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET size=excluded.size,hold=NULL,state=excluded.state")
          .run(principal,entry.name,info.size,record?.expires ?? existing?.expires ?? 0,existing?.parent ?? null,null,existing?.state==="deleting"?"deleting":record?"complete":"orphan");
        if(existing?.hold)this.release(principal,existing.hold);
        seen.add(entry.name);
      }
    }finally{dir.closeSync();}
    for(const row of this.db.prepare("SELECT * FROM raw_objects").all() as unknown as ObjectRow[])if(!seen.has(row.id)){
      if(row.hold)this.release(row.principal,row.hold);
      if(owned.has(row.id))this.db.prepare("UPDATE raw_objects SET size=0,hold=NULL WHERE id=?").run(row.id);
      else this.db.prepare("DELETE FROM raw_objects WHERE id=?").run(row.id);
    }
    for(const row of raw)if(!this.object(row.id))this.db.prepare("INSERT INTO raw_objects VALUES(?,?,?,?,NULL,NULL,'complete')").run(row.principal,row.id,0,row.expires);
    for(const r of this.db.prepare("SELECT principal,id FROM storage_reservations WHERE purpose IN ('execution','raw_metadata','capture')").all() as {principal:string;id:string}[])this.release(r.principal,r.id);
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()){
      const jobs=this.db.prepare("SELECT j.principal,j.id,r.expires FROM jobs j JOIN records r ON j.principal=r.principal AND j.id=r.id WHERE j.state IN ('queued','running','cancel_requested') AND r.expires>=?").all(Date.now()) as {principal:string;id:string;expires:number}[];
      for(const job of jobs)this.db.prepare("INSERT OR IGNORE INTO storage_reservations VALUES(?,?,?,?,?,NULL)").run(job.principal,"status_"+job.id,65536,"job_status",job.expires);
    }
    if(fresh&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staging_usage'").get()){
      for(const row of this.db.prepare("SELECT principal,id,expires FROM records WHERE kind='upload'").all() as {principal:string;id:string;expires:number}[]){
        const upload=this.read(row.principal,row.id,"upload");
        if(upload.state!=="open"||row.expires<Date.now())continue;
        const remaining=Math.max(0,upload.size*2-upload.offset)+Math.ceil(upload.size/(1024*1024))*1024+16384;
        this.db.prepare("INSERT OR IGNORE INTO storage_reservations VALUES(?,?,?,?,?,NULL)").run(row.principal,row.id,remaining,"upload",row.expires);
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='upload_chunks'").get())
          this.db.prepare("UPDATE raw_objects SET parent=? WHERE principal=? AND id IN(SELECT raw_ref FROM upload_chunks WHERE principal=? AND upload=?)").run(row.id,row.principal,row.principal,row.id);
      }
    }
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staging_usage'").get())
      this.db.exec("DELETE FROM staging_usage WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.principal=staging_usage.principal AND r.id=staging_usage.id AND r.kind IN ('upload','staged_file'))");
    for(const r of this.db.prepare("SELECT principal,id,purpose FROM storage_reservations WHERE purpose IN ('upload','staging')").all() as {principal:string;id:string;purpose:string}[]){
      const record=this.db.prepare("SELECT kind FROM records WHERE principal=? AND id=?").get(r.principal,r.id) as any;
      if(!record||record.kind!=="upload"||this.read(r.principal,r.id,"upload").state!=="open")this.release(r.principal,r.id);
    }
  }
}
