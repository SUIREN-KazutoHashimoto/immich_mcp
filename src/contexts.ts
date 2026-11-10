import { sameApiKeyId } from "./key-identity.js";
import { createHash,randomUUID,timingSafeEqual } from "node:crypto";
import { Vault } from "./vault.js";
import { Executor,type ExecutionOptions,type ContextLease } from "./executor.js";
import { prepare,type Resolver } from "./serializer.js";
import { registry,operation } from "./registry.js";
import { validator } from "./schema.js";
import { BridgeError,type ApiCall } from "./types.js";
import { decodedResponse,readDecoded } from "./content-encoding.js";

export type ContextKind="session"|"shared_link"|"public"|"maintenance";
interface Cookie {value:string;expires:number;path:string;}
interface ContextRecord {
  kind:ContextKind;secret?:string;shareType?:"key"|"slug";mode:"special"|"general_session";
  generation:number;bindingRevision:number|null;ownerKeyId?:string;enabled:boolean;expires:number;upstream:string;
  cookies:Record<string,Cookie>;oauth?:{state:string;flowId:string;expires:number;authorizationUrl:string;callbackRef?:string;};
}
export interface RegisterContext {kind:ContextKind;credential?:string;share_type?:"key"|"slug";ttl_seconds?:number;acknowledge:boolean;source_result_ref?:string;}
const contract=registry.authContexts;
const sessionOps=new Set<string>([...contract.session_only_operations.map((r:any)=>r.operation_id),
  "getAuthStatus","validateAccessToken","getSessions","deleteSession","deleteAllSessions","logout","updateSession","lockSession"]);
const maintenanceOps=new Set<string>(contract.maintenance_runtime.operation_variants.map((r:any)=>r.operation_id));
const callbackOps=new Set(["finishOAuth","redirectOAuthToMobile","linkOAuthAccount"]);
const notice="This authentication context does not inherit API-key permissions. Immich authorizes its session, shared link or maintenance credential.";
const token=(value:any)=>{if(typeof value!=="string"||!value||value.length>16384||/[\r\n\0;]/.test(value))throw new BridgeError("invalid_credential","Invalid context credential");return value;};
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
export class Contexts {
  private busy=new Set<string>();
  readonly callbackUrl:string;
  constructor(readonly vault:Vault,readonly executor:Executor,publicOrigin:string) {
    const origin=new URL(publicOrigin);
    if(origin.protocol!=="https:"||origin.origin!==publicOrigin)throw Error("Context callback requires a fixed HTTPS public origin");
    this.callbackUrl=publicOrigin+"/connect/oauth/callback";
    vault.db.exec("CREATE TABLE IF NOT EXISTS oauth_states(principal TEXT NOT NULL,digest TEXT NOT NULL,context_ref TEXT NOT NULL,flow_id TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,digest))");
  }
  private get(principal:string,id:string,active=true):ContextRecord {
    const r=this.vault.get(principal,id,"auth_context") as ContextRecord;
    if(r.upstream!==this.executor.base || !r.enabled)throw new BridgeError("invalid_context","Context is disconnected or has a different upstream");
    if(active && r.bindingRevision!==null && this.vault.credential(principal).revision!==r.bindingRevision)
      throw new BridgeError("context_revalidation_required","Context requires verification against the current API-key binding");
    return r;
  }
  private save(principal:string,id:string,r:ContextRecord){this.vault.put(principal,"auth_context",r,r.expires,id);}
  private async probe(id:string,path:Record<string,string>,headers:Headers) {
    const prepared=await prepare(this.executor.base,{operation_id:id,path});
    const response=await this.executor.http(prepared.url,{method:prepared.method,headers,redirect:"manual",signal:AbortSignal.timeout(15000)});
    if(response.status!==200){await response.body?.cancel();throw new BridgeError("context_verification_failed","Upstream did not verify the candidate credential");}
    try{
      const bytes=await decodedResponse(response,65536);
      const data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
      validator(prepared.operation.definition.responses["200"].content["application/json"].schema,registry.schemas)(data);
      return data;
    }catch{throw new BridgeError("context_verification_failed","Unexpected verification response");}
  }
  private async verifySession(principal:string,session:string) {
    const credential=this.vault.credential(principal);
    const me=await this.probe("getMyApiKey",{},new Headers({"x-api-key":credential.key}));
    if(!sameApiKeyId(me.id,credential.keyId))throw new BridgeError("credential_conflict","Registered API-key identity changed");
    const matched=await this.probe("getApiKey",{id:me.id},new Headers({authorization:"Bearer "+session}));
    if(!sameApiKeyId(matched.id,me.id) || this.vault.credential(principal).revision!==credential.revision)
      throw new BridgeError("context_verification_failed","Session owner or binding revision mismatch");
    return {revision:credential.revision,keyId:me.id as string};
  }
  async register(principal:string,input:RegisterContext) {
    if(!input || Object.keys(input).some(k=>!["kind","credential","share_type","ttl_seconds","acknowledge","source_result_ref"].includes(k)) ||
      !["session","shared_link","public","maintenance"].includes(input.kind) || input.acknowledge!==true)
      throw new BridgeError("context_consent","Explicit context consent is required");
    const ttl=input.ttl_seconds ?? 3600,cap=input.kind==="maintenance"?14400:86400;
    if(!Number.isSafeInteger(ttl)||ttl<60||ttl>cap)throw new BridgeError("context_expiry","Invalid context lifetime");
    if(this.list(principal).filter(x=>x.enabled).length>=20)throw new BridgeError("context_quota","Context quota reached");
    let secret=input.credential;
    if(input.source_result_ref){
      if(secret)throw new BridgeError("invalid_credential","Choose a credential or a result reference");
      const source=this.vault.get(principal,input.source_result_ref,"result");this.assertResult(principal,source);
      if(input.kind==="maintenance"){
        if(!["setMaintenanceMode","maintenanceLogin","startDatabaseRestoreFlow"].includes(source.display.operation_id) || !source.transport_secret_ref)
          throw new BridgeError("invalid_reference","Result has no maintenance credential");
        const transport=this.vault.get(principal,source.transport_secret_ref,"transport_secret");
        const cookie=(transport.cookies ?? []).find((c:string)=>c.startsWith("immich_maintenance_token="));
        if(cookie)secret=cookie.split(";")[0]!.slice("immich_maintenance_token=".length);
      }else if(input.kind==="session"){
        if(!["login","finishOAuth","createSession"].includes(source.display.operation_id) || source.raw.size>65536 || source.raw.interrupted)
          throw new BridgeError("invalid_reference","Result has no supported session credential");
        const bytes=await readDecoded(this.vault.rawStream(principal,source.raw.raw_ref),source.raw.content_encoding ?? "identity",65536);
        const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));secret=body.accessToken ?? body.token;
      }else throw new BridgeError("invalid_reference","This context cannot import that result");
    }
    const r:ContextRecord={kind:input.kind,mode:"special",generation:1,bindingRevision:null,enabled:true,
      expires:Date.now()+ttl*1000,upstream:this.executor.base,cookies:{}};
    if(input.kind==="public"){if(secret||input.share_type)throw new BridgeError("invalid_credential","Public context has no credential");}
    else{
      r.secret=token(secret);
      if(input.kind==="session"){
        const owner=await this.verifySession(principal,r.secret);r.bindingRevision=owner.revision;r.ownerKeyId=owner.keyId;
      }else if(input.kind==="shared_link"){
        r.bindingRevision=this.vault.credential(principal).revision;
        if(!["key","slug"].includes(input.share_type ?? "key"))throw new BridgeError("invalid_credential","Invalid shared-link credential kind");
        r.shareType=input.share_type ?? "key";
      }
    }
    const id=this.vault.put(principal,"auth_context",r,r.expires);
    return this.describe(principal,id);
  }
  check(principal:string,id:string,generation?:number) {
    const r=this.get(principal,id);
    if(generation!==undefined && r.generation!==generation)throw new BridgeError("invalid_reference","Context generation changed");
    return this.describe(principal,id);
  }
  describe(principal:string,id:string) {
    const r=this.vault.get(principal,id,"auth_context") as ContextRecord,b=this.vault.binding(principal);
    return {context_ref:id,kind:r.kind,mode:r.mode,generation:r.generation,enabled:r.enabled,
      binding_revision:r.bindingRevision,requires_revalidation:r.bindingRevision!==null && (b?.state!=="active"||b.revision!==r.bindingRevision),
      expires_at:new Date(r.expires).toISOString(),api_key_permissions_inherited:false,notice,oauth_callback_url:this.callbackUrl};
  }
  list(principal:string) {
    const rows=this.vault.db.prepare("SELECT id FROM records WHERE principal=? AND kind='auth_context' AND expires>? ORDER BY rowid DESC").all(principal,Date.now()) as any[];
    return rows.map(row=>this.describe(principal,row.id));
  }
  async revalidate(principal:string,id:string,generation:number) {
    const r=this.get(principal,id,false);
    if(r.kind!=="session" || r.generation!==generation)throw new BridgeError("context_conflict","Context changed or is not a session");
    const owner=await this.verifySession(principal,r.secret!);
    const current=this.get(principal,id,false);
    if(current.generation!==generation)throw new BridgeError("context_conflict","Context changed during verification");
    current.bindingRevision=owner.revision;current.ownerKeyId=owner.keyId;current.generation++;
    this.save(principal,id,current);return this.describe(principal,id);
  }
  setSessionMode(principal:string,id:string,generation:number,general:boolean,acknowledge:boolean) {
    const r=this.get(principal,id);
    if(r.kind!=="session"||r.generation!==generation||acknowledge!==true)throw new BridgeError("context_consent","Explicit current session-mode consent is required");
    r.mode=general?"general_session":"special";r.generation++;this.save(principal,id,r);return this.describe(principal,id);
  }
  revoke(principal:string,id:string,generation:number) {
    const r=this.get(principal,id,false);
    if(r.generation!==generation)throw new BridgeError("context_conflict","Context changed");
    r.enabled=false;r.generation++;this.save(principal,id,r);
    return {context_ref:id,state:"disconnected",upstream_session_revoked:false};
  }
  assertResult(principal:string,result:any) {
    if(result.context_ref){
      const r=this.get(principal,result.context_ref);
      if(r.generation!==result.context_generation)throw new BridgeError("invalid_reference","Context generation changed");
    }else if(this.vault.credential(principal).revision!==result.revision)throw new BridgeError("invalid_reference","Result binding changed");
  }
  private scope(r:ContextRecord,id:string) {
    const op=operation(id);
    const allowed=r.kind==="public"?op.auth.public:
      r.kind==="maintenance"?maintenanceOps.has(id):
      r.kind==="shared_link"?op.auth.shared_link_supported || contract.shared_link_only_operations.some((x:any)=>x.operation_id===id):
      r.mode==="general_session" || sessionOps.has(id);
    if(!allowed)throw new BridgeError("context_purpose","This workflow does not use that authentication context; normal API-key execution remains available");
  }
  private cookies(r:ContextRecord,headers:Headers) {
    const allowed=r.kind==="shared_link"?["immich_shared_link_token"]:
      r.kind==="maintenance"?["immich_maintenance_token"]:["immich_oauth_state","immich_oauth_code_verifier"];
    for(const cookie of headers.getSetCookie()){
      const [pair,...attrs]=cookie.split(";"),equals=pair!.indexOf("="),name=pair!.slice(0,equals),value=pair!.slice(equals+1);
      if(equals<1 || !allowed.includes(name))continue;
      let expiry=r.expires,path="/";
      for(const attr of attrs){const [key,...rest]=attr.trim().split("="),v=rest.join("=");
        if(key?.toLowerCase()==="max-age" && /^-?[0-9]+$/.test(v))expiry=Math.min(expiry,Date.now()+Number(v)*1000);
        if(key?.toLowerCase()==="expires"){const date=Date.parse(v);if(Number.isFinite(date))expiry=Math.min(expiry,date);}
        if(key?.toLowerCase()==="path" && v.startsWith("/"))path=v;
      }
      if(expiry<=Date.now() || !value)delete r.cookies[name];else {token(value);r.cookies[name]={value,expires:expiry,path};}
    }
  }
  private invocation(principal:string,id:string,input:ApiCall,resolver:Resolver,adapterInputs:Record<string,any>) {
    if(!adapterInputs || typeof adapterInputs!=="object" || Array.isArray(adapterInputs) || Object.keys(adapterInputs).some(k=>k!=="oauth_callback_ref"))throw new BridgeError("adapter_input","Unknown adapter input");
      const r=this.get(principal,id);this.scope(r,input.operation_id);
      let callback:any;
      if(adapterInputs.oauth_callback_ref){
        if(typeof adapterInputs.oauth_callback_ref!=="string" || !callbackOps.has(input.operation_id))throw new BridgeError("adapter_input","Callback reference is not applicable");
        callback=this.vault.get(principal,adapterInputs.oauth_callback_ref,"oauth_callback");
        if(callback.context_ref!==id || callback.generation!==r.generation || callback.flow_id!==r.oauth?.flowId || callback.used)
          throw new BridgeError("invalid_callback","OAuth callback is expired, used or belongs to another workflow");
      }
      const call=structuredClone(input),secrets:Record<string,string>={};
      if(callback && input.operation_id!=="redirectOAuthToMobile"){
        call.body ??= {};call.secret_bindings ??= [];
        for(const [pointer,value] of [["/url",callback.url],["/state",callback.query.state]] as const){
          if(Object.hasOwn(call.body,pointer.slice(1)) || call.secret_bindings.some(b=>b.pointer===pointer))throw new BridgeError("adapter_input","Callback input must come only from its workflow reference");
          const ref="adapter_"+randomUUID();secrets[ref]=value;
          call.secret_bindings.push({location:"body",pointer,secret_ref:ref});
        }
      }
    const resolved:Resolver={validate:resolver.validate?()=>resolver.validate!():undefined,file:ref=>resolver.file(ref),secret:(ref,location,pointer)=>Object.hasOwn(secrets,ref)?Promise.resolve(secrets[ref]):resolver.secret(ref,location,pointer)};
    return {r,call,callback,resolved};
  }
  async validateCall(principal:string,id:string,input:ApiCall,resolver:Resolver,adapterInputs:Record<string,any>={}) {
    const {r,call,resolved}=this.invocation(principal,id,input,resolver,adapterInputs);
    const prepared=await prepare(this.executor.base,call,resolved);prepared.validateResources();
    return this.check(principal,id,r.generation);
  }
  async call(principal:string,id:string,input:ApiCall,resolver:Resolver,adapterInputs:Record<string,any>={},options:ExecutionOptions={}) {
    if(Object.keys(adapterInputs).some(k=>k!=="oauth_callback_ref"))throw new BridgeError("adapter_input","Unknown adapter input");
    const key=JSON.stringify([principal,id]);
    if(this.busy.has(key))throw new BridgeError("context_busy","Context workflow already has an in-flight request");
    this.busy.add(key);
    try{
      const {r,call,callback,resolved}=this.invocation(principal,id,input,resolver,adapterInputs);
      const lease:ContextLease={notice,displayKind:r.kind==="session"?(r.mode==="general_session"?"explicit_session_workflow":"session_special"):r.kind==="public"?"public_auth":r.kind,kind:r.kind,revision:r.bindingRevision ?? 0,contextRef:id,generation:r.generation,
        validate:()=>{const current=this.get(principal,id);if(current.generation!==r.generation)throw new BridgeError("context_conflict","Context changed before send");},
        apply:request=>{
          if(r.kind==="session")request.headers.set("authorization","Bearer "+r.secret);
          if(r.kind==="shared_link")request.headers.set(r.shareType==="slug"?"x-immich-share-slug":"x-immich-share-key",r.secret!);
          if(r.kind==="maintenance" && !(r.cookies.immich_maintenance_token?.expires!>Date.now()))request.headers.set("cookie","immich_maintenance_token="+r.secret);
          const jar=Object.entries(r.cookies).filter(([,c])=>c.expires>Date.now() &&
            (request.url.pathname===c.path||request.url.pathname.startsWith(c.path.endsWith("/")?c.path:c.path+"/"))).map(([name,c])=>name+"="+c.value);
          if(jar.length)request.headers.set("cookie",[request.headers.get("cookie"),...jar].filter(Boolean).join("; "));
          if(callback && input.operation_id==="redirectOAuthToMobile")for(const[name,value]of Object.entries<string>(callback.query))request.url.searchParams.set(name,value);
        },
        beforeSend:()=>{if(callback){const current=this.vault.get(principal,adapterInputs.oauth_callback_ref,"oauth_callback");
          if(current.used)throw new BridgeError("invalid_callback","OAuth callback was consumed");
          current.used=true;this.vault.put(principal,"oauth_callback",current,current.expires,adapterInputs.oauth_callback_ref);}},
        receive:(headers,bytes,status)=>{
          const current=this.get(principal,id);if(current.generation!==r.generation)return;
          this.cookies(current,headers);
          if(input.operation_id==="startOAuth" && status>=200&&status<300 && bytes && input.body?.redirectUri===this.callbackUrl){
            const url=new URL(JSON.parse(bytes.toString("utf8")).url);
            const state=url.searchParams.get("state");
            if(url.protocol!=="https:"||url.username||url.password||!state||state.length>4096)throw new BridgeError("oauth_state","Invalid OAuth authorization response");
            const flowId=randomUUID(),expires=Math.min(current.expires,Date.now()+600000);
            current.oauth={state,flowId,expires,authorizationUrl:url.toString()};
            this.vault.db.prepare("INSERT OR REPLACE INTO oauth_states VALUES(?,?,?,?,?)").run(principal,createHash("sha256").update(state).digest("hex"),id,flowId,expires);
          }
          this.save(principal,id,current);
        }};
      const result=await this.executor.callContext(principal,call,resolved,lease,options);
      return {...result,api_key_permissions_inherited:false,context_notice:notice};
    }finally{this.busy.delete(key);}
  }
  async beginOAuth(principal:string,id:string,resolver:Resolver) {
    const result=await this.call(principal,id,{operation_id:"startOAuth",body:{redirectUri:this.callbackUrl}},resolver);
    const current=this.get(principal,id);
    if(!result.upstream || result.upstream.status<200 || result.upstream.status>=300 || !current.oauth)throw new BridgeError("oauth_start_failed","Authorization did not start; review the authenticated original result");
    return current.oauth.authorizationUrl;
  }
  acceptOAuthCallback(principal:string,rawUrl:string) {
    const url=new URL(rawUrl);
    if(url.origin+url.pathname!==this.callbackUrl || url.hash || [...url.searchParams.keys()].some(k=>!["code","state","session_state","iss","error","error_description"].includes(k)) ||
      url.searchParams.getAll("state").length!==1 || [...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))
      throw new BridgeError("invalid_callback","Invalid OAuth callback shape");
    const state=url.searchParams.get("state")!;
    if(!state || state.length>4096 || rawUrl.length>16384 || !url.searchParams.get("code")&&!url.searchParams.get("error"))throw new BridgeError("invalid_callback","OAuth callback is missing required values");
    const row=this.vault.db.prepare("SELECT context_ref,flow_id,expires FROM oauth_states WHERE principal=? AND digest=?").get(principal,createHash("sha256").update(state).digest("hex")) as any;
    if(!row || row.expires<=Date.now())throw new BridgeError("invalid_callback","OAuth workflow is unavailable");
    const r=this.get(principal,row.context_ref);
    if(!r.oauth || r.oauth.flowId!==row.flow_id || !equal(r.oauth.state,state))throw new BridgeError("invalid_callback","OAuth state mismatch");
    if(r.oauth.callbackRef){
      const existing=this.vault.get(principal,r.oauth.callbackRef,"oauth_callback");
      if(existing.url!==rawUrl)throw new BridgeError("invalid_callback","Callback already has different data");
      return {context_ref:row.context_ref,callback_ref:r.oauth.callbackRef,used:existing.used};
    }
    const expires=row.expires;
    const ref=this.vault.put(principal,"oauth_callback",{context_ref:row.context_ref,generation:r.generation,
      flow_id:row.flow_id,url:rawUrl,query:Object.fromEntries(url.searchParams),used:false,expires},expires);
    r.oauth.callbackRef=ref;this.save(principal,row.context_ref,r);
    return {context_ref:row.context_ref,callback_ref:ref,used:false};
  }
}
