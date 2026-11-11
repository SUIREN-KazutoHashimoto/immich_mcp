import { readFileSync } from "node:fs";
import type { LocalReadiness } from "./readiness.js";
import { supportedImmichVersions } from "./immich-version.js";

export const APPLICATION_VERSION="1.0.0-beta.7";
function buildRevision():string|null {
  try{
    const value=JSON.parse(readFileSync(new URL("./build-info.json",import.meta.url),"utf8"));
    if(value.version!==APPLICATION_VERSION||value.revision!==null&&!/^[0-9a-f]{40}$/.test(value.revision))throw Error("Invalid build metadata");
    return value.revision;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
const revision=buildRevision();
export interface UpstreamReadiness {state:"ok"|"unreachable"|"version_mismatch";checked_at:string;}
export interface ServerStatus {ready:boolean;local:LocalReadiness;cleanup:"ok"|"error";observedVersion:string|null;}
const object=(properties:Record<string,any>)=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const check={type:"string",enum:["ok","error"]},nullableString={type:["string","null"]};
const localSchema=object({database:check,migration:check,master_key:check,storage:check,registry:check,checked_at:{type:"string",format:"date-time"}});
export const serverInfoDescriptor={
  name:"immich_get_server_info",
  description:"Read this MCP server's application version, build revision, instance start time/uptime, cached health checks, supported and observed Immich versions, and available tools. Use this to verify which MCP release is actually running. The MCP application version is separate from the fixed Immich API contract version. Requires the authenticated MCP connection but no registered Immich API key. Does not contact Immich or refresh health checks; inspect checked_at. Does not expose secrets, configuration URLs/paths, photos, user identifiers or other users' data.",
  inputSchema:{type:"object",properties:{},additionalProperties:false},
  outputSchema:object({
    schema_version:{type:"string",const:"1"},
    server:object({name:{type:"string",const:"immich-mcp"},version:{type:"string"},build_revision:{type:["string","null"],pattern:"^[0-9a-f]{40}$"},
      started_at:{type:"string",format:"date-time"},uptime_seconds:{type:"integer",minimum:0},transport:{type:"string",const:"streamable-http"}}),
    readiness:object({ready:{type:["boolean","null"]},local_checks:{anyOf:[localSchema,{type:"null"}]},storage_cleanup:{type:["string","null"],enum:["ok","error",null]}}),
    immich:object({api_contract_version:{type:"string",const:"3.3.5"},supported_versions:{type:"array",items:{type:"string"}},
      observed_version:nullableString,state:{type:"string",enum:["ok","unreachable","version_mismatch"]},checked_at:{type:"string",format:"date-time"}}),
    capabilities:object({tool_count:{type:"integer",minimum:1},tools:{type:"array",items:{type:"string"},uniqueItems:true},
      image_read:{type:"boolean",const:true},image_preview:{type:"boolean",const:true}})
  }),
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{}
};
export class ServerInfo {
  private readonly startedAt=new Date().toISOString();
  private readonly started=performance.now();
  constructor(private readonly names:readonly string[],private readonly health:()=>UpstreamReadiness,private readonly status?:()=>ServerStatus){}
  read(){
    const upstream=this.health(),status=this.status?.(),local=status?.local;
    // Explicit field projection: future internal diagnostic fields must not leak into this tool.
    const checks=local?{database:local.database,migration:local.migration,master_key:local.master_key,storage:local.storage,registry:local.registry,checked_at:local.checked_at}:null;
    return {schema_version:"1",server:{name:"immich-mcp",version:APPLICATION_VERSION,build_revision:revision,started_at:this.startedAt,
      uptime_seconds:Math.max(0,Math.floor((performance.now()-this.started)/1000)),transport:"streamable-http"},
      readiness:{ready:status?.ready??null,local_checks:checks,storage_cleanup:status?.cleanup??null},
      immich:{api_contract_version:"3.3.5",supported_versions:[...supportedImmichVersions],observed_version:status?.observedVersion??null,
        state:upstream.state,checked_at:upstream.checked_at},
      capabilities:{tool_count:this.names.length,tools:[...this.names],image_read:true,image_preview:true}};
  }
}
export function observedImmichVersion(value:{major:number;minor:number;patch:number;prerelease:unknown}):string|null {
  if(![value.major,value.minor,value.patch].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647))return null;
  const suffix=value.prerelease===null?"":typeof value.prerelease==="string"&&/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(value.prerelease)?"-"+value.prerelease:null;
  if(suffix===null)return null;
  const text=`${value.major}.${value.minor}.${value.patch}${suffix}`;
  return text.length<=64?text:null;
}
