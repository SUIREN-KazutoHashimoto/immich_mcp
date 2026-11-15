import { controlPage as html,controlSecurity as security,connectionView,referenceReceipt,controlError,statusLabel,formatBytes } from "./control-ui.js";
import { createHmac } from "node:crypto";
import { AccessAuth, Csrf } from "./access.js";
import { Executor } from "./executor.js";
import { Vault } from "./vault.js";
import { registry, operation } from "./registry.js";
import { pointer } from "./projection.js";
import { BridgeError } from "./types.js";
import type { Resolver } from "./serializer.js";
import type { Staging } from "./staging.js";
import type { Jobs } from "./jobs.js";
import type { Uploads } from "./uploads.js";
import { uploadScript } from "./upload-script.js";
import { ContextControl } from "./context-control.js";
import type { Contexts } from "./contexts.js";
import { encodingView,normalizeEncoding } from "./content-encoding.js";

const escape=(value:any)=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export class Control {
  private csrf:Csrf;
  private contextControl?:ContextControl;
  constructor(readonly access:AccessAuth,readonly vault:Vault,readonly executor:Executor,csrfKey:Buffer,readonly staging?:Staging,readonly jobs?:Jobs,readonly uploads?:Uploads,readonly contexts?:Contexts) {
    if(contexts)this.contextControl=new ContextControl(contexts,(p,o,c)=>this.resolver(p,o,c));
    this.csrf=new Csrf(createHmac("sha256",csrfKey).update("immich-mcp-csrf-v1").digest());
  }
  private form(token:string,revision?:number) {
    return '<input type="hidden" name="csrf" value="'+escape(token)+'">'+
      (revision!==undefined?'<input type="hidden" name="revision" value="'+revision+'">':"");
  }
  async fetch(request:Request):Promise<Response> {
    try {
      this.access.validateOrigin(request.headers.get("origin") ?? undefined);
      const principal=await this.access.authenticate(request.headers.get("cf-access-jwt-assertion") ?? undefined);
      const url=new URL(request.url),path=url.pathname;
      if(path==="/connect/oauth/callback" && request.method==="GET"){
        if(!this.contextControl)throw new BridgeError("invalid_callback","OAuth workflow unavailable");
        return html(this.contextControl.callback(principal,request.url));
      }
      if(path==="/connect/upload.js" && request.method==="GET")
        return new Response(uploadScript,{headers:{...security,"content-type":"application/javascript; charset=utf-8"}});
      if(path.startsWith("/connect/upload/"))return await this.upload(request,principal,url);
      if(request.method==="GET" && path==="/connect") {
        const token=this.csrf.issue(principal);
        const binding=this.vault.binding(principal);
        const revision=binding?.revision ?? 0,storage=this.vault.storage.usage(principal);
        const recentJobs=this.jobs?.recent(principal) ?? [];
        const restored=this.vault.db.prepare("SELECT 1 FROM records WHERE principal='__system' AND id='restore_notice' AND kind='restore_notice'").get();
        const recent=this.vault.db.prepare("SELECT id,expires FROM records WHERE principal=? AND kind='result' ORDER BY rowid DESC LIMIT 10").all(principal) as any[];
        const jobs=recentJobs.map(job=>'<section class="record"><p><span class="badge '+(job.state==="completed"?"good":["failed","outcome_unknown"].includes(job.state)?"warning":"")+'">'+escape(statusLabel(job.state))+'</span></p><p><code>'+escape(job.job_ref)+'</code></p><p class="record-meta">リクエスト <code>'+escape(job.request_id)+'</code></p>'+
          (["queued","running","cancel_requested"].includes(job.state)?'<form method="post" action="/connect/job/cancel">'+this.form(token)+'<input type="hidden" name="job_ref" value="'+escape(job.job_ref)+'"><button class="secondary">停止を依頼</button></form>':"")+'</section>').join("");
        return html(connectionView({state:binding?.state??"unregistered",label:principal.slice(0,12),used:storage.used_bytes,quota:storage.quota_bytes,
          keyHidden:this.form(token,revision),secretHidden:this.form(token),contexts:this.contextControl?.render(principal,token)??"",
          uploads:!!this.uploads,principal,jobs,results:recent.filter(r=>r.expires>Date.now()).map(r=>this.resultForm(principal,r.id,token)).join(""),restore:!!restored}),
          "__Host-immich-csrf="+token+"; Path=/; Secure; HttpOnly; SameSite=Strict");
      }
      if(request.method!=="POST" || !["/connect/key","/connect/disconnect","/connect/secret","/connect/raw","/connect/job/cancel","/connect/context/register","/connect/context/revoke","/connect/context/revalidate","/connect/context/mode","/connect/context/oauth"].includes(path))
        return new Response("Not found",{status:404,headers:security});
      this.access.validateOrigin(request.headers.get("origin") ?? undefined,true);
      const contentType=request.headers.get("content-type") ?? "";
      if(!contentType.startsWith("application/x-www-form-urlencoded"))throw new BridgeError("invalid_input","Expected form submission");
      // Bound form reads independently from upstream file uploads.
      const bytes:Uint8Array[]=[];let count=0;
      for await(const chunk of request.body ?? []){
        count+=chunk.length;if(count>64*1024)throw new BridgeError("input_limit","Form is too large");bytes.push(chunk);
      }
      const form=new URLSearchParams(Buffer.concat(bytes).toString("utf8"));
      const required=(name:string)=>{const values=form.getAll(name);if(values.length!==1)throw new BridgeError("invalid_input","Missing or duplicate form field");return values[0]!;};
      const cookie=request.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-immich-csrf="))?.slice("__Host-immich-csrf=".length) ?? "";
      this.csrf.verify(principal,required("csrf"),cookie);
      if(path.startsWith("/connect/context/")){
        if(!this.contextControl)throw new BridgeError("invalid_context","Context service unavailable");
        const result=await this.contextControl.action(principal,path,form);
        return result.body?html(result.body):new Response(null,{status:303,headers:{...security,location:result.redirect!}});
      }
      const revision=()=>{const n=Number(required("revision"));if(!Number.isSafeInteger(n)||n<0)throw new BridgeError("invalid_input","Invalid revision");return n;};
      if(path==="/connect/key") await this.executor.register(principal,required("key"),revision());
      if(path==="/connect/disconnect") this.vault.disconnect(principal,revision());
      if(path==="/connect/job/cancel"){
        if(!this.jobs)throw new BridgeError("invalid_reference","Job unavailable");
        this.jobs.cancel(principal,required("job_ref"));
      }
      if(path==="/connect/secret"){
        const id=required("operation_id"),path=required("pointer"),value=required("value");
        operation(id);
        if(!registry.secretRules.some(r=>r.bindings.some((b:any)=>b.operation_id===id && b.direction==="request" && b.instance_pointer_pattern===path)))
          throw new BridgeError("invalid_secret_binding","This target is not a declared sensitive input");
        if(form.getAll("context_ref").length>1)throw new BridgeError("invalid_input","Duplicate context reference");
        const scope=form.get("context_ref") ?? "";
        const context=scope?this.contexts?.check(principal,scope):undefined;
        if(scope&&!context)throw new BridgeError("invalid_context","Context unavailable");
        const revision=context?this.vault.resourceRevision(principal):this.vault.credential(principal).revision;
        const ref=this.vault.put(principal,"secret",{value,revision,operation_id:id,pointer:path,location:"body",
          ...(context?{context_ref:scope,context_generation:context.generation}:{})});
        return html(referenceReceipt("秘密情報の参照IDを発行しました","指定した操作と入力先で、この参照IDを利用できます。",ref));
      }
      if(path==="/connect/raw"){
        const result=this.vault.get(principal,required("result_ref"),"result");
        this.assertResult(principal,result);
        const {metadata,completeness,encoding}=this.originalStatus(principal,result);
        const suffix=(completeness==="complete"?"":completeness==="incomplete"?".partial":".unverified")+(encoding!=="identity"?".encoded":"");
        return new Response(this.vault.rawStream(principal,result.raw.raw_ref) as any,
          {headers:{...security,"content-type":"application/octet-stream","content-disposition":'attachment; filename="immich-original'+suffix+'.bin"',
            "x-immich-original-completeness":completeness,"x-immich-original-content-encoding":encoding,
            ...(Number.isSafeInteger(metadata.size)&&metadata.size>=0?{"content-length":String(metadata.size)}:{}),
            ...(/^[a-f0-9]{64}$/.test(metadata.sha256)?{"x-immich-received-sha256":metadata.sha256}:{})}});
      }
      return new Response(null,{status:303,headers:{...security,location:"/connect"}});
    }catch(error){
      const code=error instanceof BridgeError?error.code:"control_error";
      const status=code==="unauthenticated"?401:code==="invalid_origin"||code==="csrf"?403:400;
      if(new URL(request.url).pathname.startsWith("/connect/upload/"))
        return new Response(JSON.stringify({error:{code}}),{status,headers:{...security,"content-type":"application/json"}});
      return htmlError(code,status);
    }
  }
  private originalStatus(principal:string,result:any) {
    const metadata=this.vault.get(principal,result.raw.raw_ref,"raw");
    const incomplete=result.raw.interrupted===true||metadata.transfer_complete===false;
    const completeness=incomplete?"incomplete":metadata.transfer_complete===true?"complete":"unknown";
    return {metadata,completeness,encoding:encodingView(normalizeEncoding(result.raw.content_encoding))};
  }
  private resultForm(principal:string,id:string,token:string) {
    try{
      const result=this.vault.get(principal,id,"result");this.assertResult(principal,result);
      const {metadata,completeness,encoding}=this.originalStatus(principal,result);
      const label=completeness==="complete"?"原本の受信が完了しています。":
        completeness==="incomplete"?"受信が未完了です。取得できた部分のみで、完全なファイルではありません。":
        "受信の完了状態が記録されていません。利用前にファイルを確認してください。";
      return '<section class="record"><p>'+escape(label)+' 受信サイズ: '+escape(formatBytes(metadata.size))+'</p>'+(encoding!=="identity"?'<p class="muted">元のHTTP転送形式: '+escape(encoding)+'。ダウンロードされるデータは、転送時の形式のままです。</p>':"")+
        '<form method="post" action="/connect/raw">'+this.form(token)+
        '<input type="hidden" name="result_ref" value="'+escape(id)+'"><button class="secondary">原本をダウンロード</button><p class="record-meta"><code>'+escape(id)+'</code></p></form></section>';
    }catch{return "";}
  }
  private async upload(request:Request,principal:string,url:URL) {
    if(!this.uploads)throw new BridgeError("invalid_reference","Upload service unavailable");
    const action=url.pathname.slice("/connect/upload/".length);
    const json=(value:any)=>new Response(JSON.stringify(value),{headers:{...security,"content-type":"application/json"}});
    const query=(allowed:string[])=>{
      if([...url.searchParams.keys()].some(k=>!allowed.includes(k)) || allowed.some(k=>url.searchParams.getAll(k).length!==1))
        throw new BridgeError("invalid_upload","Invalid upload parameters");
    };
    if(action==="status" && request.method==="GET"){query(["ref"]);return json(this.uploads.status(principal,url.searchParams.get("ref")!));}
    if(request.method!=="POST" || !["start","chunk","complete","abort"].includes(action))
      return new Response("Not found",{status:404,headers:security});
    this.access.validateOrigin(request.headers.get("origin") ?? undefined,true);
    const cookie=request.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-immich-csrf="))?.slice("__Host-immich-csrf=".length) ?? "";
    this.csrf.verify(principal,request.headers.get("x-csrf-token") ?? "",cookie);
    if(action==="chunk"){
      query(["ref","index","sha256"]);
      if(request.headers.get("content-type")!=="application/octet-stream" || !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("index")!))
        throw new BridgeError("invalid_upload","Invalid chunk request");
      return json(await this.uploads.append(principal,url.searchParams.get("ref")!,Number(url.searchParams.get("index")),url.searchParams.get("sha256")!,request.body ?? (async function*(){})()));
    }
    query([]);
    if(request.headers.get("content-type")!=="application/json")throw new BridgeError("invalid_upload","Expected JSON");
    let size=0;const chunks:Uint8Array[]=[];
    for await(const c of request.body ?? []){size+=c.length;if(size>8192)throw new BridgeError("input_limit","Upload metadata is too large");chunks.push(c);}
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new BridgeError("invalid_upload","Invalid JSON");}
    if(!body || typeof body!=="object" || Array.isArray(body))throw new BridgeError("invalid_upload","Expected upload object");
    if(action==="start")return json(this.uploads.start(principal,body));
    if(Object.keys(body).some(k=>k!=="upload_ref") || typeof body.upload_ref!=="string")throw new BridgeError("invalid_upload","Expected upload reference");
    return json(action==="complete"?await this.uploads.complete(principal,body.upload_ref):await this.uploads.abort(principal,body.upload_ref));
  }
  private assertResult(principal:string,result:any) {
    if(this.contexts)this.contexts.assertResult(principal,result);
    else if(this.vault.credential(principal).revision!==result.revision)throw new BridgeError("invalid_reference","Result binding has changed");
  }
  resolver(principal:string,operationId:string,contextRef?:string):Resolver {
    const revision=this.vault.resourceRevision(principal),used:[string,string,string][]=[];
    const read=(ref:string,location:string,path:string)=>{
      const record=this.vault.get(principal,ref,"secret");
      if(record.context_ref){
        if(!this.contexts || record.context_ref!==contextRef)throw new BridgeError("invalid_reference","Secret belongs to another context");
        this.contexts.check(principal,record.context_ref,record.context_generation);
      }else if(record.revision!==this.vault.credential(principal).revision)throw new BridgeError("invalid_reference","Secret binding changed");
      if(record.operation_id!==operationId || record.location!==location || record.pointer!==path)
        throw new BridgeError("invalid_reference","Secret target or binding mismatch");
      return record.value;
    };
    return {
      validate:()=>{
        if(this.vault.resourceRevision(principal)!==revision)throw new BridgeError("credential_conflict","Input reference binding changed before send");
        for(const [ref,location,path]of used)read(ref,location,path);
      },
      file:async(ref)=>{if(!this.staging)throw new BridgeError("invalid_reference","No staged file is available");return this.staging.file(principal,ref);},
      secret:async(ref,location,path)=>{const value=read(ref,location,path);used.push([ref,location,path]);return value;}
    };
  }
  readResult(principal:string,ref:string,path=""){
    const result=this.vault.get(principal,ref,"result");
    this.assertResult(principal,result);
    return pointer(result.display,path);
  }
}
function htmlError(code:string,status:number){return controlError(code,status);}
