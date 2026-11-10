import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Operation,Schema } from "../src/types.js";
interface Fingerprint {version:string;commit:string;sha256:string;}
const component="TimeBucketAssetResponseDto",reference={$ref:"#/components/schemas/"+component};
const componentHash="121723224c5281e18d421708757b61e2510451d7ad1f9d79ec418e447e0eb1c4";
const statusSchema={type:"array",items:{type:"string",enum:["active","trashed","deleted"]}};
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=(value:any)=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
// Only this exact response/component may gain this source-verified enum array.
// Shared components, unknown fields/statuses, authentication and secret rules are unchanged.
export function applyTimelineStatusCorrection(operations:Operation[],schemas:Record<string,Schema>,secretRules:Schema[],contract:any,baseline:Fingerprint):Operation[]{
  const allowed=["format","version","immich_version","source_commit","openapi_sha256","operation_id","http_method","api_relative_path","openapi_operation_pointer",
    "status_code","content_type","expected_schema","component_name","component_sha256","property_name","property_schema","fact_id","source_urls","evidence_scope"];
  const sources=["repositories/asset.repository.ts","dtos/time-bucket.dto.ts","enum.ts"].map(path=>"https://github.com/immich-app/immich/blob/"+baseline.commit+"/server/src/"+path);
  if(!contract||typeof contract!=="object"||Array.isArray(contract)||Object.keys(contract).some(k=>!allowed.includes(k))||
    contract.format!=="immich-mcp-timeline-status-response-correction"||contract.version!==1||
    contract.immich_version!==baseline.version||contract.source_commit!==baseline.commit||contract.openapi_sha256!==baseline.sha256)
    throw Error("Timeline correction fingerprint mismatch");
  if(contract.operation_id!=="getTimeBucket"||contract.http_method!=="GET"||contract.api_relative_path!=="/timeline/bucket"||
    contract.openapi_operation_pointer!=="#/paths/~1timeline~1bucket/get"||contract.status_code!==200||contract.content_type!=="application/json"||
    !isDeepStrictEqual(contract.expected_schema,reference)||contract.component_name!==component||contract.component_sha256!==componentHash||
    contract.property_name!=="status"||!isDeepStrictEqual(contract.property_schema,statusSchema)||contract.fact_id!=="time_bucket_asset_status_column"||
    !Array.isArray(contract.source_urls)||!isDeepStrictEqual(contract.source_urls.toSorted(),sources.toSorted()))
    throw Error("Invalid or stale timeline correction");
  const matches=operations.filter(o=>o.operationId==="getTimeBucket"),op=matches[0],schema=schemas[component];
  if(matches.length!==1||!op||op.method!=="GET"||op.path!=="/timeline/bucket"||
    !isDeepStrictEqual(op.definition.responses["200"]?.content?.["application/json"]?.schema,reference)||
    !schema||digest(schema)!==componentHash||schema.type!=="object"||!schema.properties||Object.hasOwn(schema.properties,"status"))
    throw Error("Timeline correction schema mismatch");
  for(const rule of secretRules){
    if(!Array.isArray(rule.bindings))throw Error("Invalid secret rule bindings");
    if(rule.bindings.some((b:any)=>b.direction==="response"&&(b.operation_id==="getTimeBucket"||b.operation_id==="*")))
      throw Error("Timeline correction cannot alter secret-bearing responses");
  }
  if(op.override?.facts?.some((f:any)=>f.fact_id===contract.fact_id))throw Error("Duplicate timeline correction fact");
  const corrected=structuredClone(schema);
  corrected.properties={...corrected.properties,status:structuredClone(statusSchema)};
  // Preserve the DTO's required set. Existing DTO-shaped replies remain valid.
  const response=op.definition.responses["200"],media=response.content["application/json"],override=op.override?structuredClone(op.override):{
    operation_id:op.operationId,http_method:op.method,api_relative_path:op.path,openapi_operation_pointer:contract.openapi_operation_pointer,facts:[],requirements:[],source_urls:[]
  };
  override.facts.push({fact_id:contract.fact_id,evidence_level:"source_verified",value:{status_code:200,content_type:"application/json",component_name:component,
    original_component_sha256:componentHash,property_name:"status",property_schema:structuredClone(statusSchema),runtime_verified:false},source_urls:[...sources]});
  override.source_urls=[...new Set([...override.source_urls,...sources])];
  const target={...op,override,definition:{...op.definition,responses:{...op.definition.responses,"200":{...response,content:{...response.content,
    "application/json":{...media,schema:corrected}}}}}};
  return operations.map(o=>o===op?target:o);
}
