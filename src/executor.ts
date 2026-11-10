import { sameApiKeyId } from "./key-identity.js";
import { randomUUID } from "node:crypto";
import { prepare, type Resolver, type Prepared } from "./serializer.js";
import { registry } from "./registry.js";
import { validator } from "./schema.js";
import { redact, safeShape } from "./projection.js";
import { Vault } from "./vault.js";
import { BridgeError, type ApiCall } from "./types.js";
import { SyncProjection } from "./sync-projection.js";
import type { PagedProjection } from "./result-pages.js";
import { JsonProjection } from "./json-projection.js";
import type { JsonProjectionMeta } from "./json-tree.js";
import { Upstream,UpstreamError,sendUpstream,releaseUpstream,type UpstreamOptions } from "./upstream.js";
import { decodeContent,decodedResponse,normalizeEncoding,encodingView } from "./content-encoding.js";

export interface ExecutionOptions {signal?:AbortSignal;requestId?:string;beforeSend?:()=>void;onBindingTransition?:(result:any)=>void;}
export interface ContextLease {
  displayKind?:string;notice:string;kind:"session"|"shared_link"|"public"|"maintenance";revision:number;contextRef:string;generation:number;
  validate():void;apply(request:Prepared):void;beforeSend?():void;
  receive?(headers:Headers,bytes:Buffer|undefined,status:number):void;
}
export interface ExecutorLimits {resultTtlMs?:number;jsonValueBytes?:number;maxDecodedBytes?:number;upstream?:UpstreamOptions;}
export class Executor {
  readonly resultTtlMs:number;readonly jsonValueBytes:number;readonly maxDecodedBytes:number;readonly http:typeof fetch;
  private owned?:Upstream;private stopping=new AbortController();private pending=new Set<Promise<unknown>>();private closing?:Promise<void>;
  constructor(readonly base:string,readonly vault:Vault,http:typeof fetch|undefined=undefined,
    readonly maxBytes=1024*1024*1024,readonly inlineBytes=1024*1024,limits:ExecutorLimits={}) {
    this.resultTtlMs=limits.resultTtlMs ?? 3600_000;this.jsonValueBytes=limits.jsonValueBytes ?? 1024*1024;this.maxDecodedBytes=limits.maxDecodedBytes ?? maxBytes;
    for(const value of [maxBytes,inlineBytes,this.resultTtlMs,this.jsonValueBytes,this.maxDecodedBytes])if(!Number.isSafeInteger(value)||value<1)throw Error("Invalid executor resource limit");
    if(!http)this.owned=new Upstream(base,limits.upstream);this.http=http ?? this.owned!.fetch;
  }
  private track<T>(work:()=>Promise<T>):Promise<T>{
    if(this.stopping.signal.aborted)return Promise.reject(new BridgeError("shutting_down","Execution has stopped"));
    const task=Promise.resolve().then(work);this.pending.add(task);
    task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
  }
  register(principal:string,key:string,expectedRevision:number){return this.track(()=>this.registerInner(principal,key,expectedRevision));}
  call(principal:string,input:ApiCall,resolver?:Resolver,options:ExecutionOptions={}){return this.track(()=>this.callInner(principal,input,resolver,options));}
  callContext(principal:string,input:ApiCall,resolver:Resolver,lease:ContextLease,options:ExecutionOptions={}){return this.track(()=>this.contextInner(principal,input,resolver,lease,options));}
  close(){return this.closing ??= (async()=>{this.stopping.abort();await this.owned?.close();await Promise.allSettled([...this.pending]);})();}

  private async registerInner(principal:string,key:string,expectedRevision:number) {
    if (!key || /[\r\n]/.test(key)) throw new BridgeError("invalid_key","Invalid API key");
    const req = await prepare(this.base,{operation_id:"getMyApiKey"});
    req.headers.set("x-api-key",key);
    const response = await this.http(req.url,{headers:req.headers,redirect:"manual",signal:AbortSignal.any([this.stopping.signal,AbortSignal.timeout(15000)])});
    if (response.status !== 200) { await response.body?.cancel(); throw new BridgeError("key_validation_failed","Upstream rejected candidate key"); }
    const bytes = await decodedResponse(response,64*1024,this.stopping.signal);
    const value = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    const schema=req.operation.definition.responses["200"].content["application/json"].schema;
    validator(schema,registry.schemas)(value);
    return this.vault.replaceBinding(principal,key,value.id,expectedRevision);
  }
  private async callInner(principal:string,input:ApiCall,resolver?:Resolver,options:ExecutionOptions={}) {
    // Snapshot exactly one credential; never retry with another key or context.
    const credential=this.vault.credential(principal);
    const prepared=await prepare(this.base,input,resolver);
    if (this.vault.credential(principal).revision !== credential.revision) throw new BridgeError("credential_conflict","Credential changed before send");
    prepared.headers.set("x-api-key",credential.key);
    return this.perform(principal,input,prepared,credential,"api_key",options);
  }
  private async contextInner(principal:string,input:ApiCall,resolver:Resolver,lease:ContextLease,options:ExecutionOptions={}) {
    lease.validate();
    const prepared=await prepare(this.base,input,resolver);
    lease.validate();lease.apply(prepared);
    const binding=this.vault.binding(principal);
    return this.perform(principal,input,prepared,{revision:lease.revision,keyId:binding?.key_id ?? ""},lease.kind,
      {...options,beforeSend:()=>{lease.validate();lease.beforeSend?.();options.beforeSend?.();}},lease);
  }
  private async perform(principal:string,input:ApiCall,prepared:Prepared,credential:{revision:number;keyId:string},
    kind:string,options:ExecutionOptions,lease?:ContextLease) {
    const json=prepared.operation.operationId==="getSyncStream"||Object.values<any>(prepared.operation.definition.responses).some(r=>r.content?.["application/json"]);
    const allocation="execution_"+randomUUID(),bytes=json?2*this.inlineBytes+4*128*1024+65536:196608;
    this.vault.storage.reserve(principal,allocation,bytes,"execution",Date.now()+Math.max(this.resultTtlMs,120000));
    const release=this.vault.pin(principal,allocation);
    try{return await this.execute(principal,input,prepared,credential,kind,options,lease,allocation);}
    finally{this.vault.storage.release(principal,allocation);release();}
  }
  private async execute(principal:string,input:ApiCall,prepared:Prepared,credential:{revision:number;keyId:string},
    kind:string,options:ExecutionOptions,lease:ContextLease|undefined,allocation:string) {
    const authContextKind=lease?.displayKind ?? kind;
    const requestId=options.requestId ?? "req_"+randomUUID();
    const signal=AbortSignal.any([this.stopping.signal,...(options.signal?[options.signal]:[])]);
    signal.throwIfAborted();
    let response:Response,dispatched=false;
    try {
      response=await sendUpstream(this.http,prepared.url,{method:prepared.method,headers:prepared.headers,body:prepared.body as any,
        ...(prepared.body && typeof prepared.body !== "string" ? {duplex:"half"} : {}),
        redirect:"manual",signal} as RequestInit,()=>{
          signal.throwIfAborted();prepared.validateResources();
          if(kind==="api_key"&&this.vault.credential(principal).revision!==credential.revision)
            throw new BridgeError("credential_conflict","Credential changed while waiting to send");
          options.beforeSend?.();dispatched=true;
        },true);
    } catch(error) {
      if(!dispatched)throw error;
      const knownUnsent=error instanceof UpstreamError&&!error.mayHaveBeenSent;
      return {schema_version:"1",operation_id:input.operation_id,request_id:requestId,state:knownUnsent?"failed":"outcome_unknown",
        auth_context_kind:authContextKind,upstream:null,result_ref:null,job_ref:null,data:null,
        diagnostic:{code:error instanceof UpstreamError?error.code:"transport_interrupted",message:knownUnsent?"Connection failed before request transmission":"Request outcome is unknown; no automatic retry",
          ...(error instanceof UpstreamError?{phase:error.phase,request_may_have_been_sent:error.mayHaveBeenSent}:{})},truncated:false};
    }
    try{
    const mime=response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const chunks:Buffer[]=[];
    const resultExpires=Date.now()+this.resultTtlMs;
    const selfRotation=(kind==="api_key"||kind==="session")&&input.operation_id==="rotateApiKey"&&response.status>=200&&response.status<300&&sameApiKeyId(input.path?.id,credential.keyId);
    const rotationSecrets=new Set<string>();
    const pendingSecrets:{id:string;value:string}[]=[];let pendingBytes=0;
    const flushSecrets=()=>{
      if(!pendingSecrets.length)return;
      this.vault.storage.atomic(()=>{for(const item of pendingSecrets)
        this.vault.put(principal,"secret",{value:item.value,revision:credential.revision,context_ref:lease?.contextRef,context_generation:lease?.generation},resultExpires,item.id);
      });
      pendingSecrets.length=0;pendingBytes=0;
    };
    const saveSecret=(secret:string)=>{
      const bytes=Buffer.byteLength(secret);if(pendingSecrets.length&&(pendingSecrets.length>=32||pendingBytes+bytes>128*1024))flushSecrets();
      const id="secret_"+randomUUID();
      if(selfRotation){if(rotationSecrets.size>=32)throw new BridgeError("rotation_recovery_required","Rotation secret inventory exceeded its bound");rotationSecrets.add(id);}
      pendingSecrets.push({id,value:secret});pendingBytes+=bytes;
      if(pendingBytes>128*1024)flushSecrets();
      return id;
    };
    const isSync=input.operation_id==="getSyncStream"&&response.status===200;
    const sync=isSync&&mime==="application/jsonlines+json"?new SyncProjection(this.vault,principal,saveSecret,resultExpires):undefined;
    const responseSchema=prepared.operation.definition.responses[String(response.status)]?.content?.[mime]?.schema;
    const json=response.status>=200&&response.status<300&&mime==="application/json"&&responseSchema?
      new JsonProjection(this.vault,principal,responseSchema,input.operation_id,response.status,saveSecret,resultExpires,this.jsonValueBytes):undefined;
    let projection:PagedProjection|JsonProjectionMeta|undefined;
    let inspected=0,decodedComplete=false,previewSkipped=false,inspectionError:BridgeError|undefined;
    const encoding=normalizeEncoding(response.headers.get("content-encoding"));
    let raw:{raw_ref:string;size:number;sha256:string;interrupted:boolean;interruption_code?:string;content_encoding?:string};
    try { raw=await this.vault.capture(principal,response.body ?? (async function*(){})(),this.maxBytes,
      undefined,resultExpires,true,{metadataReservation:allocation}); } catch(error) {
      try{sync?.pages.discard();json?.discard();}catch{/* The result remains unavailable. */}
      return {schema_version:"1",operation_id:input.operation_id,request_id:requestId,state:"outcome_unknown",
        auth_context_kind:authContextKind,upstream:{status:response.status,content_type:mime,headers:{}},
        result_ref:null,job_ref:null,data:null,truncated:false,
        diagnostic:{code:error instanceof BridgeError?error.code:"response_interrupted",message:"Response transfer did not complete; no automatic retry"}};
    }
    raw.content_encoding=encoding;
    try{
      if(!sync&&!json&&encoding==="identity"&&raw.size>this.inlineBytes)previewSkipped=true;
      else{
        for await(const chunk of decodeContent(this.vault.rawStream(principal,raw.raw_ref),encoding,this.maxDecodedBytes,signal)){
          sync?.push(chunk);await json?.push(chunk);inspected+=chunk.length;
          if(inspected<=this.inlineBytes)chunks.push(Buffer.from(chunk));else chunks.length=0;
          if(!sync&&!json&&inspected>this.inlineBytes)break;
        }
        decodedComplete=(!!sync||!!json||inspected<=this.inlineBytes)&&!raw.interrupted;
      }
    }catch(error){
      inspectionError=error instanceof BridgeError?error:new BridgeError("response_projection_withheld","Response inspection did not complete");
      chunks.length=0;
    }
    const bytes=!inspectionError&&!previewSkipped&&inspected<=this.inlineBytes ? Buffer.concat(chunks) : undefined;
    const status=response.status;
    const headers:Record<string,string>={};
    for (const name of ["content-type","content-length","content-encoding","content-range","accept-ranges","etag","last-modified","retry-after"]) {
      const value=response.headers.get(name); if (value) headers[name]=name==="content-encoding"?encodingView(encoding):value;
    }
    const transportSecrets:Record<string,any>={};
    if (response.headers.get("location")) transportSecrets.location=response.headers.get("location");
    if (response.headers.getSetCookie().length) transportSecrets.cookies=response.headers.getSetCookie();
    const transportSecretRef=Object.keys(transportSecrets).length?this.vault.put(principal,"transport_secret",transportSecrets,resultExpires,undefined,allocation):null;
    let data:any=null;
    let diagnostic:any=raw.interrupted?{code:raw.interruption_code ?? "response_interrupted",message:"Response transfer or storage did not complete; no automatic retry"}:null;
    let state=raw.interrupted?"outcome_unknown":"completed",truncated=raw.interrupted;
    if(inspectionError&&!raw.interrupted){
      state=inspectionError.code==="upstream_cancelled"?"outcome_unknown":"failed";truncated=true;
      diagnostic={code:inspectionError.code,message:"Response display did not complete; encrypted original retained"};
    }
    if(!raw.interrupted)try {this.vault.withReservation(principal,allocation,()=>lease?.receive?.(response.headers,bytes,status));}catch{diagnostic ??= {code:"context_update_failed",message:"Response retained; context state needs review"};}
    if(sync){
      try{
        projection=sync.finish(raw.interrupted||!!inspectionError);flushSecrets();
        if(raw.interrupted&&raw.interruption_code)projection.error=raw.interruption_code;
        else if(inspectionError)projection.error=inspectionError.code;
        data=sync.pages.read(0,16);truncated=projection.total_records>data.length||!projection.complete;
        if(projection.error){state=raw.interrupted||inspectionError?.code==="upstream_cancelled"?"outcome_unknown":"failed";diagnostic={code:projection.error,message:"Sync stream is incomplete; retained records are a partial display"};}
        else if(projection.terminal==="SyncResetV1")diagnostic={code:"sync_reset_required",message:"Upstream requires sync reset",source:"upstream"};
        if(Buffer.byteLength(JSON.stringify(data))>this.inlineBytes){data=null;truncated=true;diagnostic ??= {code:"large_jsonl_result",message:"Read the complete sanitized records through result_ref in JSONL mode"};}
      }catch(error){
        state="failed";truncated=true;data=null;projection=undefined;
        diagnostic={code:error instanceof BridgeError?error.code:"jsonl_projection_failed",message:"Stream display could not be stored; original retained"};
        try{sync.pages.discard();}catch{/* No page reference is exposed. */}
      }
    }else if(isSync){
      state="failed";diagnostic={code:"unexpected_stream_content_type",message:"Upstream did not return the expected sync stream format"};
    }else if(json){
      if(raw.interrupted||inspectionError){json.discard();}
      else try{
        projection=await json.finish();flushSecrets();
        try{data=json.tree.value(projection.root,this.inlineBytes);}
        catch(error){
          if(!(error instanceof BridgeError)||error.code!=="result_page_too_large")throw error;
          diagnostic={code:"large_json_result",message:"Read the complete sanitized JSON through result_ref and /data JSON Pointers"};
        }
      }catch(error){
        data=null;state="failed";projection=undefined;
        diagnostic={code:error instanceof BridgeError?(error.code==="invalid_input"?"response_schema_mismatch":error.code):"response_projection_withheld",message:"JSON display unavailable; original retained for authenticated control UI"};
        try{json.discard();}catch{/* No display-tree reference is exposed. */}
      }
    } else if (!raw.interrupted && !inspectionError && (bytes?.length || inspected || raw.size)) {
      diagnostic={code: status>=400 ? "upstream_error" : "artifact_result",message:"Original retained for authenticated control UI"};
    }
    const envelope={schema_version:"1",operation_id:input.operation_id,request_id:requestId,
      upstream:{status,content_type:mime,headers},state,auth_context_kind:authContextKind,
      data,result_ref:null as string|null,job_ref:null,truncated,diagnostic,
      ...(lease?{api_key_permissions_inherited:false,context_notice:lease.notice}:{})};
    const resultRef="result_"+randomUUID();
    envelope.result_ref=resultRef;
    // A self-rotation stays uncertain until key, result and any job receipt
    // commit together. A crash or failed write must not leave a success display.
    const recovery=selfRotation?{...envelope,state:"outcome_unknown",diagnostic:{code:"rotation_recovery_required",message:"Rotation requires authenticated recovery; no automatic retry"}}:undefined;
    this.vault.put(principal,"result",{revision:credential.revision,display:recovery ?? envelope,raw,projection,decoded_bytes_inspected:inspected,decoded_complete:decodedComplete,transport_secret_ref:transportSecretRef,context_ref:lease?.contextRef,context_generation:lease?.generation},resultExpires,resultRef,allocation);
    // Extract only the schema-validated fields from the persisted projection.
    // A large name/permissions array must not prevent a valid key transition.
    if(selfRotation){
      if(raw.interrupted||inspectionError||state!=="completed"||projection?.kind!=="json"||!json)return recovery!;
      try{
        const id=json.tree.value(json.tree.locate(projection.root,"/id"),this.jsonValueBytes);
        const reference=json.tree.value(json.tree.locate(projection.root,"/secret"),1024);
        if(!sameApiKeyId(id,credential.keyId)||!reference||typeof reference.secret_ref!=="string"||!rotationSecrets.has(reference.secret_ref))
          throw new BridgeError("rotation_recovery_required","Rotated key identity differs");
        const secret=this.vault.get(principal,reference.secret_ref,"secret");
        if(typeof secret.value!=="string"||!secret.value||secret.revision!==credential.revision||secret.context_ref!==lease?.contextRef||secret.context_generation!==lease?.generation)
          throw new BridgeError("rotation_recovery_required","Rotated credential provenance differs");
        this.vault.replaceBinding(principal,secret.value,credential.keyId,credential.revision,allocation,revision=>{
          this.vault.put(principal,"result",{revision,display:envelope,raw,projection,decoded_bytes_inspected:inspected,decoded_complete:decodedComplete,transport_secret_ref:transportSecretRef,
            binding_transition:{kind:"self_rotation",key_id:credential.keyId,from_revision:credential.revision,to_revision:revision,
              context_ref:lease?.contextRef,context_generation:lease?.generation}},resultExpires,resultRef,allocation);
          options.onBindingTransition?.(envelope);
        });
      }catch{return recovery!;}
    }
    if ((kind==="api_key" || kind==="session") && input.operation_id==="deleteApiKey" && status>=200 && status<300 && sameApiKeyId(input.path?.id,credential.keyId))
      this.vault.disconnect(principal,credential.revision);
    return envelope;
    }finally{releaseUpstream(response);}
  }
}
