import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { Vault } from "./vault.js";
import { Executor } from "./executor.js";
import { Contexts } from "./contexts.js";
import { AccessAuth } from "./access.js";
import { Staging } from "./staging.js";
import { DownloadPolicy } from "./download.js";
import { Uploads } from "./uploads.js";
import { Control } from "./control.js";
import { Jobs } from "./jobs.js";
import { ToolService,type Readiness } from "./tools.js";
import { BridgeError } from "./types.js";
import { operation,registry } from "./registry.js";
import { validator } from "./schema.js";
import { decodedResponse } from "./content-encoding.js";
import { UpstreamError } from "./upstream.js";
import { runtimeIntegrity } from "./runtime-integrity.js";
import { inspectLocal,localReady,type LocalReadiness } from "./readiness.js";
export interface AppOptions {http?:typeof fetch;jwks?:JWTVerifyGetKey;downloads?:DownloadPolicy;databasePath?:string;versionIntervalMs?:number;cleanupIntervalMs?:number;localIntervalMs?:number;runtimeIntegrity?:()=>Promise<"ok"|"error">;}
const noStore={"cache-control":"no-store","x-content-type-options":"nosniff"};
export class Application {
  readonly vault:Vault;readonly executor:Executor;readonly contexts:Contexts;readonly access:AccessAuth;
  readonly staging:Staging;readonly uploads:Uploads;readonly jobs:Jobs;readonly control:Control;readonly tools:ToolService;
  readonly mcp:ReturnType<typeof createMcpHandler>;
  health:Readiness={state:"unreachable",checked_at:new Date(0).toISOString()};
  private pending=new Set<Promise<Response>>();private closing?:Promise<void>;private cleaning?:Promise<void>;private cleanupTimer?:ReturnType<typeof setInterval>;
  localHealth:LocalReadiness={database:"error",migration:"error",master_key:"error",storage:"error",registry:"error",checked_at:new Date(0).toISOString()};
  private localIntegrity:()=>Promise<"ok"|"error">;private localChecking?:Promise<void>;private localTimer?:ReturnType<typeof setInterval>;private lastLocalCheck=0;
  cleanupState:"ok"|"error"="ok";private cleanupAbort?:AbortController;
  stopping=false;private timer?:ReturnType<typeof setInterval>;private checking?:Promise<void>;
  private constructor(readonly config:Config,options:AppOptions) {
    this.localIntegrity=options.runtimeIntegrity ?? runtimeIntegrity;
    this.access=new AccessAuth({issuer:config.issuer,audience:config.audience,jwksUrl:config.jwksUrl,publicOrigin:config.publicOrigin},options.jwks);
    this.vault=new Vault(config.directory,config.masterKey,createHash("sha256").update(config.upstream).digest("hex"),options.databasePath ?? config.databasePath,{quotaBytes:config.storageQuotaBytes ?? 3221225472,globalQuotaBytes:config.globalStorageQuotaBytes ?? 12884901888});
    let createdExecutor:Executor|undefined;
    try {
    this.executor=createdExecutor=new Executor(config.upstream,this.vault,options.http,config.maxResultBytes,config.inlineResultMaxBytes,
      {resultTtlMs:config.resultTtlMs,jsonValueBytes:config.jsonValueMaxBytes,maxDecodedBytes:config.maxDecodedResultBytes,
        upstream:{concurrency:config.maxUpstreamConcurrency,connectTimeoutMs:config.upstreamConnectTimeoutMs,idleTimeoutMs:config.upstreamIdleTimeoutMs}});
    this.contexts=new Contexts(this.vault,this.executor,config.publicOrigin);
    this.staging=new Staging(this.vault,options.downloads ?? new DownloadPolicy(config.fileSourceHosts ?? []),{maxFileBytes:config.maxUploadBytes,quotaBytes:config.storageQuotaBytes,ttlMs:config.stagingTtlMs});
    this.uploads=new Uploads(this.staging);
    let control:Control;
    this.jobs=new Jobs(this.vault,this.executor,(p,o,c)=>control.resolver(p,o,c),
      {autoStart:false,maxPendingPerPrincipal:config.maxJobsPerPrincipal,gate:id=>this.assertVersion(id)},this.contexts);
    this.control=control=new Control(this.access,this.vault,this.executor,config.masterKey,this.staging,this.jobs,this.uploads,this.contexts);
    this.tools=new ToolService(this.vault,this.executor,this.contexts,this.control,this.staging,this.jobs,config.publicOrigin,()=>this.health,{inlineBytes:config.inlineResultMaxBytes,resultTtlMs:config.resultTtlMs,gate:()=>this.assertLocalReady()});
    this.mcp=createMcpHandler(ctx=>{
      const principal=ctx.authInfo?.extra?.principal;
      if(typeof principal!=="string" || !principal)throw new Error("Verified principal is required");
      return this.tools.server(principal,ctx.requestInfo?.signal);
    },{legacy:"stateless",maxRequestBodySize:1024*1024,keepAliveMs:15000});
    }catch(error){void createdExecutor?.close().catch(()=>{});this.vault.close();throw error;}
  }
  static async create(config:Config,options:AppOptions={}) {
    if(await (options.runtimeIntegrity ?? runtimeIntegrity)()!=="ok")throw new BridgeError("runtime_integrity","Pinned runtime assets failed verification");
    await mkdir(config.directory,{recursive:true,mode:0o700});
    if(config.databasePath)await mkdir(dirname(config.databasePath),{recursive:true,mode:0o700});
    const app=new Application(config,options);
    try{
      await app.cleanStorage();await app.checkLocal(true);await app.checkVersion();app.jobs.start();
      const interval=options.versionIntervalMs ?? 30000;
      if(interval>0){app.timer=setInterval(()=>{void app.checkVersion();},interval);app.timer.unref();}
      const cleanup=options.cleanupIntervalMs ?? config.cleanupIntervalMs ?? 60000;
      if(cleanup>0){app.cleanupTimer=setInterval(()=>{void app.cleanStorage();},cleanup);app.cleanupTimer.unref();}
      const local=options.localIntervalMs ?? 30000;
      if(local>0){app.localTimer=setInterval(()=>{void app.checkLocal(true);},local);app.localTimer.unref();}
      return app;
    }catch(error){await app.close();throw error;}
  }
  cleanStorage(){
    if(this.cleaning)return this.cleaning;
    this.cleanupAbort=new AbortController();
    this.cleaning=(async()=>{try{const report=await this.vault.cleanup({signal:this.cleanupAbort!.signal});this.cleanupState=report.failures?"error":"ok";}catch{this.cleanupState="error";}})()
      .finally(()=>{this.cleaning=undefined;});return this.cleaning;
  }
  checkLocal(force=false):Promise<void>{
    if(this.localChecking)return this.localChecking;
    if(this.stopping||!force&&Date.now()-this.lastLocalCheck<30000)return Promise.resolve();
    this.localChecking=(async()=>{this.localHealth=await inspectLocal(this.vault,this.config.masterKeyFile,this.localIntegrity);this.lastLocalCheck=Date.now();})()
      .finally(()=>{this.localChecking=undefined;});return this.localChecking;
  }
  private assertLocalReady(){
    if(!localReady(this.localHealth)||this.cleanupState!=="ok")throw new BridgeError("storage_unavailable","Local storage and runtime checks are not ready");
  }
  assertVersion(operationId:string) {
    this.assertLocalReady();
    if(this.health.state==="version_mismatch" || this.health.state!=="ok"&&!["getServerVersion","getMaintenanceStatus","maintenanceLogin"].includes(operationId))
      throw new BridgeError(this.health.state,"Upstream version contract is not ready");
  }
  async checkVersion() {
    if(this.checking)return this.checking;
    this.checking=(async()=>{
      let state:Readiness["state"]="unreachable";
      try{
        const url=new URL(this.config.upstream+"/server/version");
        const response=await this.executor.http(url,{redirect:"manual",signal:AbortSignal.timeout(5000)});
        if(response.status===200){
          const bytes=await decodedResponse(response,16384);
          const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
          validator(operation("getServerVersion").definition.responses["200"].content["application/json"].schema,registry.schemas)(value);
          state=value.major===3&&value.minor===3&&value.patch===5&&value.prerelease===null?"ok":"version_mismatch";
        }else await response.body?.cancel();
      }catch(error){
        // A locally cancelled wait did not inspect the upstream at all.
        if(!this.stopping&&error instanceof BridgeError&&!(error instanceof UpstreamError)&&["upstream_cancelled","upstream_busy"].includes(error.code))return;
      }
      this.health={state,checked_at:new Date().toISOString()};
    })();
    try{await this.checking;}finally{this.checking=undefined;}
  }
  fetch(request:Request):Promise<Response>{
    const task=this.handle(request);this.pending.add(task);
    task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
  }
  private async handle(request:Request):Promise<Response> {
    const url=new URL(request.url);
    if(url.origin!==this.config.publicOrigin)return new Response("Invalid request origin",{status:403,headers:noStore});
    if(url.pathname==="/health/live")return Response.json({live:!this.stopping},{status:this.stopping?503:200,headers:noStore});
    if(url.pathname==="/health/ready"){
      await this.checkLocal();
      const ready=!this.stopping&&this.health.state==="ok"&&this.cleanupState==="ok"&&localReady(this.localHealth);
      return Response.json({ready,version_state:this.health.state,storage_cleanup:this.cleanupState,checks:this.localHealth},{status:ready?200:503,headers:noStore});
    }
    if(url.pathname==="/.well-known/oauth-protected-resource")
      return Response.json({resource:this.config.publicOrigin+"/mcp",authorization_servers:[this.config.publicOrigin],bearer_methods_supported:["header"]},{headers:noStore});
    if(this.stopping)return new Response("Shutting down",{status:503,headers:noStore});
    try{
      this.access.validateOrigin(request.headers.get("origin") ?? undefined);
      const principal=await this.access.authenticate(request.headers.get("cf-access-jwt-assertion") ?? undefined);
      if(url.pathname==="/mcp"){
        const response=await this.mcp.fetch(request,{authInfo:{token:"access-assertion-verified",clientId:"cloudflare-access",scopes:[],extra:{principal}}});
        response.headers.set("cache-control","no-store");
        return response;
      }
      if(url.pathname.startsWith("/connect")){
        if(request.method==="POST")this.assertLocalReady();
        if(this.health.state==="version_mismatch" && ["/connect/key","/connect/context/register","/connect/context/revalidate","/connect/context/oauth"].includes(url.pathname))
          throw new BridgeError("version_mismatch","Upstream version does not match the pinned contract");
        return await this.control.fetch(request);
      }
      return new Response("Not found",{status:404,headers:noStore});
    }catch(error){
      const code=error instanceof BridgeError?error.code:"request_failed";
      const status=code==="unauthenticated"?401:code==="invalid_origin"?403:400;
      return Response.json({error:{code}},{status,headers:{...noStore,...(status===401?{"www-authenticate":'Bearer resource_metadata="'+this.config.publicOrigin+'/.well-known/oauth-protected-resource"'}:{})}});
    }
  }
  close() {return this.closing ??= this.shutdown();}
  private async shutdown() {
    this.stopping=true;if(this.localTimer)clearInterval(this.localTimer);if(this.timer)clearInterval(this.timer);if(this.cleanupTimer)clearInterval(this.cleanupTimer);this.cleanupAbort?.abort();
    await this.jobs.close();await this.executor.close();await this.mcp.close();await Promise.allSettled([...this.pending]);
    if(this.checking)await this.checking;if(this.cleaning)await this.cleaning;
    if(this.localChecking)await this.localChecking;
    this.vault.close();
  }
}
