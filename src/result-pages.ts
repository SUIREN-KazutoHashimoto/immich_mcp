import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { BridgeError } from "./types.js";
export interface PagedProjection {kind:"jsonl";stream_id:string;total_records:number;complete:boolean;terminal:string|null;error:string|null;}
export class ResultPages {
  readonly streamId:string;
  count=0;private pending:any[]=[];private pendingBytes=0;
  constructor(readonly vault:Vault,readonly principal:string,readonly expires=Date.now()+3600_000,streamId?:string){
    this.streamId=streamId ?? "projection_"+randomUUID();
    vault.db.exec("CREATE TABLE IF NOT EXISTS result_pages(principal TEXT NOT NULL,stream TEXT NOT NULL,start INTEGER NOT NULL,count INTEGER NOT NULL,ref TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,stream,start))");
  }
  append(value:any){
    const bytes=Buffer.byteLength(JSON.stringify(value));
    if(this.pending.length&&(this.pending.length>=64||this.pendingBytes+bytes>128*1024))this.flush();
    this.pending.push(value);this.pendingBytes+=bytes;this.count++;
  }
  flush(){
    if(!this.pending.length)return;
    this.vault.db.exec("BEGIN IMMEDIATE");
    try{
      const ref=this.vault.put(this.principal,"model_page",{records:this.pending},this.expires);
      this.vault.db.prepare("INSERT INTO result_pages VALUES(?,?,?,?,?,?)").run(this.principal,this.streamId,this.count-this.pending.length,this.pending.length,ref,this.expires);
      this.vault.db.exec("COMMIT");this.pending=[];this.pendingBytes=0;
    }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
  }
  read(offset:number,limit:number){
    const rows=this.vault.db.prepare("SELECT start,count,ref FROM result_pages WHERE principal=? AND stream=? AND start<? AND start+count>? AND expires>=? ORDER BY start")
      .all(this.principal,this.streamId,offset+limit,offset,Date.now()) as {start:number;count:number;ref:string}[];
    const records:any[]=[];
    for(const row of rows){
      const page=this.vault.get(this.principal,row.ref,"model_page").records;
      if(!Array.isArray(page)||page.length!==row.count)throw new BridgeError("invalid_reference","Result page is unavailable");
      records.push(...page.slice(Math.max(0,offset-row.start),Math.min(row.count,offset+limit-row.start)));
    }
    return records;
  }
  discard(){
    const rows=this.vault.db.prepare("SELECT ref FROM result_pages WHERE principal=? AND stream=?").all(this.principal,this.streamId) as {ref:string}[];
    this.vault.db.exec("BEGIN IMMEDIATE");
    try{
      for(const row of rows)this.vault.db.prepare("DELETE FROM records WHERE principal=? AND id=? AND kind='model_page'").run(this.principal,row.ref);
      this.vault.db.prepare("DELETE FROM result_pages WHERE principal=? AND stream=?").run(this.principal,this.streamId);
      this.vault.db.exec("COMMIT");
    }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
    this.pending=[];this.pendingBytes=0;
  }
}
