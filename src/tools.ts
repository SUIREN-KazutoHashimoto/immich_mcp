import { McpServer,fromJsonSchema } from "@modelcontextprotocol/server";
import source from "../immich_mcp_spec_v3.3.5/contracts/mcp-tool-contracts.json" with {type:"json"};
import { registry,catalog,describe,operation } from "./registry.js";
import { Vault } from "./vault.js";
import { Executor } from "./executor.js";
import { Contexts } from "./contexts.js";
import { Control } from "./control.js";
import { Staging } from "./staging.js";
import { Jobs } from "./jobs.js";
import { Views } from "./views.js";
import { Images,ImageReadError,imageDescriptor } from "./images.js";
import { IMAGE_VIEWER_URI,IMAGE_VIEWER_MIME,imageViewerResource } from "./image-viewer.js";
import { BridgeError,type ApiCall } from "./types.js";
export interface Readiness {state:"ok"|"unreachable"|"version_mismatch";checked_at:string;}
function extend(schema:any):any {
  if(!schema || typeof schema!=="object")return schema;
  if(Array.isArray(schema))return schema.map(extend);
  const result=Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,extend(v)])) as any;
  if(result.properties?.schema_version && result.properties?.auth_context_kind){
    result.properties.api_key_permissions_inherited={type:"boolean"};
    result.properties.context_notice={type:"string"};
  }
  return result;
}
export const descriptors=[...source.tools.map(t=>({...structuredClone(t),outputSchema:extend(t.outputSchema)})),imageDescriptor];
const diagnostic=(d:any)=>d?{...d,source:d.source ?? (d.code==="upstream_error"?"upstream":"mcp_bridge")}:null;
export class ToolService {
  readonly views:Views;readonly images:Images;private gate?:()=>void;
  constructor(readonly vault:Vault,readonly executor:Executor,readonly contexts:Contexts,readonly control:Control,
    readonly staging:Staging,readonly jobs:Jobs,readonly publicOrigin:string,readonly readiness:()=>Readiness,limits:{inlineBytes?:number;resultTtlMs?:number;gate?:()=>void}={}) {
    this.gate=limits.gate;this.views=new Views(vault,control,limits.inlineBytes,limits.resultTtlMs);this.images=new Images(vault,control);
  }
  private permittedVersion(id:string) {
    this.gate?.();
    const state=this.readiness().state;
    if(state==="version_mismatch" || state!=="ok"&&!["getServerVersion","getMaintenanceStatus","maintenanceLogin"].includes(id))
      throw new BridgeError(state,"Upstream version contract is not ready; inspect connection diagnostics");
  }
  private envelope(result:any) {
    const value={...result,diagnostic:diagnostic(result.diagnostic)};
    // Adapters use internal credential kinds; the MCP wrapper uses its versioned public vocabulary.
    if(value.auth_context_kind==="public")value.auth_context_kind="public_auth";
    if(value.auth_context_kind==="session")value.auth_context_kind="session_special";
    return value;
  }
  private bounded(result:any,input:ApiCall) {
    const value=this.envelope(result);
    if(value.result_ref && (input.result_mode==="reference" || Buffer.byteLength(JSON.stringify(value))>this.views.maxBytes))
      return {...value,data:null};
    return value;
  }
  private async api(principal:string,input:ApiCall,context?:{context_ref:string;adapter_inputs?:Record<string,any>},signal?:AbortSignal) {
    operation(input.operation_id);this.permittedVersion(input.operation_id);
    const op=operation(input.operation_id);
    const long=op.definition.requestBody?.content?.["multipart/form-data"] ||
      op.override?.requirements?.some((r:any)=>r.requirement_id==="response_body_handler") || !["GET","HEAD"].includes(op.method);
    const asyncMode=input.execution_mode==="async" || input.execution_mode!=="sync"&&long;
    if(asyncMode){
      const ack=await this.jobs.submit(principal,input,context);
      const meta=context?this.contexts.check(principal,context.context_ref):null;
      const kind=!meta?"api_key":meta.kind==="session"?(meta.mode==="general_session"?"explicit_session_workflow":"session_special"):meta.kind==="public"?"public_auth":meta.kind;
      return {schema_version:"1",operation_id:input.operation_id,request_id:ack.request_id,upstream:null,state:"queued",
        auth_context_kind:kind,data:null,result_ref:null,job_ref:ack.job_ref,truncated:false,diagnostic:null,
        ...(meta?{api_key_permissions_inherited:false,context_notice:meta.notice}:{})};
    }
    const resolver=this.control.resolver(principal,input.operation_id,context?.context_ref);
    const value=context?await this.contexts.call(principal,context.context_ref,input,resolver,context.adapter_inputs,{signal}):
      await this.executor.call(principal,input,resolver,{signal});
    return this.bounded(value,input);
  }
  private job(principal:string,ref:string,cancel=false) {
    const job=cancel?this.jobs.cancel(principal,ref):this.jobs.get(principal,ref);
    return {job_ref:ref,state:job.state,sent_upstream:job.send_started,upstream_response_received:job.upstream_response_received,
      result:job.result?this.bounded(job.result,{} as ApiCall):null,diagnostic:diagnostic(job.diagnostic)};
  }
  async invoke(principal:string,name:string,input:any,signal?:AbortSignal):Promise<any> {
    switch(name){
      case "immich_get_connection":{
        const binding=this.vault.binding(principal),health=this.readiness();
        return {target_version:"3.3.5",openapi_sha256:registry.sha256,binding_state:health.state==="ok"?(binding?.state ?? "unregistered"):health.state,
          connection_label:principal.slice(0,12),connect_url:this.publicOrigin+"/connect",credential_revision:binding?.revision ?? null,
          diagnostic:health.state==="ok"?null:{code:health.state,message:"Version check unavailable or mismatched",source:"mcp_bridge",details:{checked_at:health.checked_at}}};
      }
      case "immich_api_catalog":return catalog(input);
      case "immich_api_describe":{
        const operations=input.operation_ids.map((id:string)=>{const {components,...rest}=describe(id);return rest;});
        const full={operations,definitions:registry.schemas,source_sha256:registry.sha256,result_ref:null,truncated:false};
        if(Buffer.byteLength(JSON.stringify(full))<=this.views.maxBytes)return full;
        const ref=this.views.store(principal,full);
        return {operations:operations.map((o:any)=>({operation_id:o.operation_id,method:o.method,path:o.path})),
          definitions:{},source_sha256:registry.sha256,result_ref:ref,truncated:true};
      }
      case "immich_api_call":return this.api(principal,input,undefined,signal);
      case "immich_api_call_context":return this.api(principal,input.call,{context_ref:input.context_ref,adapter_inputs:input.adapter_inputs},signal);
      case "immich_stage_files":{
        const staged=await this.staging.stage(principal,input.files);
        return {files:staged.files.map(f=>({file_ref:f.file_ref,file_name:f.file_name,mime_type:f.mime_type,size_bytes:f.size,sha256:f.sha256,expires_at:f.expires_at})),
          job_ref:null,state:"completed",diagnostic:null};
      }
      case "immich_read_result":return this.views.read(principal,input);
      case "immich_read_image":this.gate?.();return this.images.read(principal,input,signal);
      case "immich_get_job":return this.job(principal,input.job_ref);
      case "immich_cancel_job":return this.job(principal,input.job_ref,true);
      default:throw new BridgeError("unknown_tool","Unknown MCP tool");
    }
  }
  server(principal:string,signal?:AbortSignal) {
    const server=new McpServer({name:"immich-mcp",version:"1.0.0-beta.5"});
    server.registerResource("immich_image_preview",IMAGE_VIEWER_URI,{mimeType:IMAGE_VIEWER_MIME,description:"Private Immich image preview"},async()=>({contents:[imageViewerResource()]}));
    for(const tool of descriptors){
      server.registerTool(tool.name,{description:tool.description+(tool.name==="immich_read_image"?"":" Large schema/result references can be read through immich_read_result using JSON Pointers.")+(tool.name==="immich_read_result"?" Preview returns metadata, not image pixels; use immich_read_image to see an image in ChatGPT.":""),
        inputSchema:fromJsonSchema<any>(tool.inputSchema as any),outputSchema:fromJsonSchema<any>(tool.outputSchema as any),
        annotations:tool.annotations,_meta:tool._meta},async(args:any)=>{
        try{
          const data=await this.invoke(principal,tool.name,args,signal);
          if(tool.name==="immich_read_image")return data;
          return {content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:data,
            ...((tool.name==="immich_api_call"||tool.name==="immich_api_call_context")&&(data.state==="outcome_unknown"||data.state==="failed"||data.upstream?.status>=400)?{isError:true}:{})};
        }catch(error){
          const code=error instanceof BridgeError?error.code:"tool_failed";
          return {isError:true,content:[{type:"text" as const,text:JSON.stringify({code,message:error instanceof BridgeError?error.message:"Request failed; inspect authenticated diagnostics",source:"mcp_bridge",...(error instanceof ImageReadError?{request_id:error.requestId}:{})})}]};
        }
      });
    }
    return server;
  }
}
