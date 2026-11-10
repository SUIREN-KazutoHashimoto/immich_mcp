import { sameApiKeyId } from "./key-identity.js";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { Executor } from "./executor.js";
import type { Contexts } from "./contexts.js";
import { prepare,type Resolver } from "./serializer.js";
import { BridgeError,type ApiCall } from "./types.js";
export type JobState="queued"|"running"|"completed"|"failed"|"cancel_requested"|"cancelled"|"outcome_unknown";
interface JobRow {principal:string;id:string;state:JobState;revision:number;operation:string;created:number;updated:number;sent:number;}
export interface JobOptions {concurrency?:number;perPrincipalConcurrency?:number;maxPendingPerPrincipal?:number;ttlMs?:number;autoStart?:boolean;gate?:(operation:string)=>void;}
export class Jobs {
  private static owners=new WeakMap<Vault,Jobs>();
  private active=new Map<string,{principal:string;controller:AbortController;promise:Promise<void>}>();
  private accepting=true;private started=false;private scheduled=false;
  private gate?: (operation:string)=>void;
  readonly concurrency:number;readonly perPrincipalConcurrency:number;readonly maxPending:number;readonly ttlMs:number;
  constructor(readonly vault:Vault,readonly executor:Executor,readonly resolver:(principal:string,operation:string,contextRef?:string)=>Resolver,options:JobOptions={},readonly contexts?:Contexts) {
    if(Jobs.owners.has(vault))throw new BridgeError("queue_owned","This vault already has a live job queue");
    this.gate=options.gate;
    this.concurrency=options.concurrency ?? 2;this.perPrincipalConcurrency=options.perPrincipalConcurrency ?? 1;
    this.maxPending=options.maxPendingPerPrincipal ?? 50;this.ttlMs=options.ttlMs ?? 86400_000;
    for(const limit of [this.concurrency,this.perPrincipalConcurrency,this.maxPending,this.ttlMs])
      if(!Number.isSafeInteger(limit)||limit<1)throw Error("Invalid job resource limit");
    vault.db.exec("CREATE TABLE IF NOT EXISTS jobs(principal TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,sent INTEGER NOT NULL,PRIMARY KEY(principal,id))");
    // Single-instance ownership must be established by the application before constructing this queue.
    vault.db.prepare("UPDATE jobs SET state=CASE WHEN sent=1 THEN 'outcome_unknown' WHEN state='cancel_requested' THEN 'cancelled' ELSE 'queued' END,updated=? WHERE state IN ('running','cancel_requested')").run(Date.now());
    for(const row of vault.db.prepare("SELECT principal,id FROM jobs WHERE state NOT IN ('queued','running','cancel_requested')").all() as {principal:string;id:string}[])
      vault.storage.release(row.principal,"status_"+row.id);
    Jobs.owners.set(vault,this);
    if(options.autoStart!==false)this.start();
  }
  private row(principal:string,id:string):JobRow {
    this.vault.get(principal,id,"job");
    const row=this.vault.db.prepare("SELECT * FROM jobs WHERE principal=? AND id=?").get(principal,id) as unknown as JobRow|undefined;
    if(!row)throw new BridgeError("invalid_reference","Job unavailable");return row;
  }
  private change(principal:string,id:string,state:JobState) {
    this.vault.db.prepare("UPDATE jobs SET state=?,updated=? WHERE principal=? AND id=?").run(state,Date.now(),principal,id);
  }
  async submit(principal:string,call:ApiCall,context?:{context_ref:string;adapter_inputs?:Record<string,any>}) {
    if(!this.accepting)throw new BridgeError("shutting_down","Job acceptance has stopped");
    if(context&&!this.contexts)throw new BridgeError("invalid_context","Context dispatcher unavailable");
    const checked=context?await this.contexts!.validateCall(principal,context.context_ref,call,this.resolver(principal,call.operation_id,context.context_ref),context.adapter_inputs):undefined;
    const revision=checked?.binding_revision ?? (context?0:this.vault.credential(principal).revision);
    if(!context)await prepare(this.executor.base,call,this.resolver(principal,call.operation_id));
    if(!this.accepting || !context && this.vault.credential(principal).revision!==revision)throw new BridgeError("credential_conflict","Credential changed before job acceptance");
    if(context)this.contexts!.check(principal,context.context_ref,checked!.generation);
    const id="job_"+randomUUID(),requestId="req_"+randomUUID(),now=Date.now();
    this.vault.db.exec("BEGIN IMMEDIATE");
    try{
      const count=this.vault.db.prepare("SELECT COUNT(*) n FROM jobs WHERE principal=? AND state IN ('queued','running','cancel_requested')").get(principal) as any;
      if(count.n>=this.maxPending)throw new BridgeError("job_quota","Pending job quota exhausted");
      this.vault.storage.reserve(principal,"status_"+id,65536,"job_status",now+this.ttlMs);
      this.vault.put(principal,"job",{call,request_id:requestId,...(context?{context_ref:context.context_ref,context_generation:checked!.generation,adapter_inputs:context.adapter_inputs ?? {}}:{})},now+this.ttlMs,id);
      this.vault.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)").run(principal,id,"queued",revision,call.operation_id,now,now,0);
      this.vault.db.exec("COMMIT");
    }catch(error){this.vault.db.exec("ROLLBACK");throw error;}
    this.schedule();
    return {job_ref:id,request_id:requestId,state:"queued" as JobState};
  }
  start() {this.started=true;this.schedule();}
  private schedule() {
    if(this.scheduled || !this.started || !this.accepting)return;
    this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.pump();});
  }
  private pump() {
    if(!this.accepting)return;
    const candidates=this.vault.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id").all() as unknown as JobRow[];
    for(const row of candidates){
      if(this.active.size>=this.concurrency)break;
      if([...this.active.values()].filter(a=>a.principal===row.principal).length>=this.perPrincipalConcurrency)continue;
      this.change(row.principal,row.id,"running");
      const controller=new AbortController();
      const promise=Promise.resolve().then(()=>this.run(row,controller)).finally(()=>{this.active.delete(row.id);this.schedule();});
      this.active.set(row.id,{principal:row.principal,controller,promise});
    }
  }
  private persistResult(row:JobRow,record:any,result:any){
    // The final receipt replaces diagnostics from a recovered unsent attempt.
    delete record.diagnostic;
    record.result={...result,data:null,upstream:result.upstream?{status:result.upstream.status,content_type:result.upstream.content_type,headers:{}}:null};
    this.vault.put(row.principal,"job",record,row.created+this.ttlMs,row.id,"status_"+row.id);
    this.change(row.principal,row.id,result.state==="outcome_unknown"?"outcome_unknown":result.state==="failed"?"failed":"completed");
  }
  private async run(row:JobRow,controller:AbortController) {
    const release=this.vault.pin(row.principal,row.id),status="status_"+row.id,releaseStatus=this.vault.pin(row.principal,status);
    try{
      const record=this.vault.get(row.principal,row.id,"job");
      const current=this.row(row.principal,row.id);
      if(current.state==="cancelled" || current.state==="cancel_requested" || controller.signal.aborted){
        this.change(row.principal,row.id,"cancelled");return;
      }
      if(record.context_ref)this.contexts?.check(row.principal,record.context_ref,record.context_generation);
      if(record.context_ref && !this.contexts)throw new BridgeError("invalid_context","Context dispatcher unavailable");
      if(!record.context_ref && this.vault.credential(row.principal).revision!==row.revision){
        record.diagnostic={code:"credential_changed",message:"Unsent job invalidated by credential change"};
        this.vault.put(row.principal,"job",record,row.created+this.ttlMs,row.id,status);
        this.change(row.principal,row.id,"cancelled");return;
      }
      this.gate?.(row.operation);
      const options={
        signal:controller.signal,requestId:record.request_id,onBindingTransition:(result:any)=>this.persistResult(row,record,result),beforeSend:()=>{
          const state=this.row(row.principal,row.id).state;
          if(state!=="running" || controller.signal.aborted)throw new BridgeError("cancelled","Unsent job cancelled");
          this.vault.db.prepare("UPDATE jobs SET sent=1,updated=? WHERE principal=? AND id=?").run(Date.now(),row.principal,row.id);
        }};
      const result=record.context_ref?
        await this.contexts!.call(row.principal,record.context_ref,record.call,this.resolver(row.principal,row.operation,record.context_ref),record.adapter_inputs,options):
        await this.executor.call(row.principal,record.call,this.resolver(row.principal,row.operation),options);
      this.persistResult(row,record,result);
    }catch(error){
      const current=this.vault.db.prepare("SELECT * FROM jobs WHERE principal=? AND id=?").get(row.principal,row.id) as unknown as JobRow;
      if(!current)return;
      // The rotation transaction already committed this terminal receipt.
      if(current.state==="completed")return;
      let record:any;
      try {record=this.vault.get(row.principal,row.id,"job");}
      catch {this.change(row.principal,row.id,current.sent?"outcome_unknown":"failed");return;}
      record.diagnostic={code:error instanceof BridgeError?error.code:"job_failed",message:current.sent?"Request outcome is unknown; no automatic replay":"Job stopped before sending"};
      this.vault.put(row.principal,"job",record,row.created+this.ttlMs,row.id,status);
      this.change(row.principal,row.id,current.sent?"outcome_unknown":controller.signal.aborted || current.state==="cancel_requested"?"cancelled":"failed");
    }finally{this.vault.storage.release(row.principal,status);releaseStatus();release();}
  }
  get(principal:string,id:string) {
    const row=this.row(principal,id),record=this.vault.get(principal,id,"job");
    const binding=this.vault.binding(principal);
    let stored:any,unavailable=false;
    if(record.result?.result_ref){try{stored=this.vault.get(principal,record.result.result_ref,"result");}catch{unavailable=true;}}
    const transition=stored?.binding_transition;
    const moved=!!transition&&Number.isSafeInteger(transition.from_revision)&&Number.isSafeInteger(transition.to_revision)&&
      stored.context_ref===undefined&&stored.context_generation===undefined&&transition.kind==="self_rotation"&&row.operation==="rotateApiKey"&&record.call.operation_id===row.operation&&
      sameApiKeyId(record.call.path?.id,transition.key_id)&&transition.from_revision===row.revision&&transition.to_revision===row.revision+1&&
      stored.revision===transition.to_revision&&binding?.state==="active"&&binding.revision===transition.to_revision&&sameApiKeyId(binding.key_id,transition.key_id)&&
      stored.display?.result_ref===record.result.result_ref&&stored.display.request_id===record.request_id&&stored.display.operation_id===row.operation&&stored.display.state==="completed"&&
      stored.display.upstream?.status>=200&&stored.display.upstream.status<300&&
      transition.context_ref===record.context_ref&&transition.context_generation===record.context_generation;
    let valid=moved||binding?.state==="active"&&binding.revision===row.revision;
    if(!moved&&record.context_ref){try{this.contexts?.check(principal,record.context_ref,record.context_generation);valid=!!this.contexts;}catch{valid=false;}}
    if(valid&&stored&&!moved&&(stored.revision!==row.revision||stored.context_ref!==record.context_ref||stored.context_generation!==record.context_generation||
      stored.display?.result_ref!==record.result.result_ref||stored.display.request_id!==record.request_id||stored.display.operation_id!==row.operation))valid=false;
    const result=valid?(record.result?.result_ref?(stored?.display ?? null):record.result ?? null):null;
    return {job_ref:id,request_id:record.request_id,operation_id:row.operation,state:row.state,
      credential_revision:row.revision,send_started:row.sent===1,upstream_response_received:!!record.result?.upstream,created_at:new Date(row.created).toISOString(),
      updated_at:new Date(row.updated).toISOString(),result,diagnostic:record.diagnostic ?? (result?.state==="outcome_unknown"?result.diagnostic:undefined) ?? (unavailable?{code:"result_unavailable",message:"Result retention has ended or the result is unavailable"}:valid?null:{code:"binding_changed",message:"Prior binding result is unavailable"})};
  }
  recent(principal:string,limit=10) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new BridgeError("invalid_limit","Invalid job list size");
    const rows=this.vault.db.prepare("SELECT j.id FROM jobs j JOIN records r ON j.principal=r.principal AND j.id=r.id WHERE j.principal=? AND r.expires>? ORDER BY j.created DESC,j.id LIMIT ?").all(principal,Date.now(),limit) as any[];
    return rows.map(r=>this.get(principal,r.id));
  }
  cancel(principal:string,id:string) {
    const row=this.row(principal,id);
    if(row.state==="queued"){this.change(principal,id,"cancelled");this.vault.storage.release(principal,"status_"+id);}
    else if(row.state==="running" || row.state==="cancel_requested"){
      this.change(principal,id,"cancel_requested");
      this.active.get(id)?.controller.abort();
    }
    return this.get(principal,id);
  }
  async idle(){while(this.active.size || this.scheduled){await new Promise(resolve=>setTimeout(resolve,5));}}
  async close() {
    this.accepting=false;
    for(const active of this.active.values())active.controller.abort();
    await Promise.allSettled([...this.active.values()].map(a=>a.promise));
    if(Jobs.owners.get(this.vault)===this)Jobs.owners.delete(this.vault);
  }
}
