import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Operation,Schema} from "../src/types.js";
export interface PluginMethodBaseline {version:string;commit:string;sha256:string;}
const targets=[
 {operation_id:"getPlugin",path:"/plugins/{id}",array:false,method:false},
 {operation_id:"searchPlugins",path:"/plugins",array:true,method:false},
 {operation_id:"searchPluginMethods",path:"/plugins/methods",array:true,method:true}
] as const;
const methodHash="5fd5fd3cabd4d4e1f6b3f95640360611945e8f39a6d77c2842bb3b9739ac0c4a";
const pluginHash="4f5af777294c6578bdabc6107af86c1a9eef6d19003fd293d34143d230a2b970";
const sourcePaths=["controllers/plugin.controller.ts","services/plugin.service.ts","repositories/plugin.repository.ts",
 "dtos/plugin.dto.ts","dtos/plugin-manifest.dto.ts","schema/tables/plugin-method.table.ts"];
const keys=["format","version","immich_version","source_commit","openapi_sha256","method_component_sha256","plugin_component_sha256","operation_ids","source_urls","evidence_scope"];
export function applyPluginMethodSchemaCorrection(operations:Operation[],schemas:Record<string,Schema>,contract:any,baseline:PluginMethodBaseline):Operation[]{
 const bad=()=>{throw Error("Stale or invalid nullable plugin method response correction");};
 if(!contract||typeof contract!=="object"||Array.isArray(contract)||Object.keys(contract).some(k=>!keys.includes(k))||
   baseline.version!=="3.3.5"||baseline.commit!=="8303cb117e197c700332b33b61b45314c9cc5bb4"||
   baseline.sha256!=="632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9"||
   contract.format!=="immich-mcp-plugin-method-schema-correction"||contract.version!==1||
   contract.immich_version!==baseline.version||contract.source_commit!==baseline.commit||contract.openapi_sha256!==baseline.sha256||
   contract.method_component_sha256!==methodHash||contract.plugin_component_sha256!==pluginHash||
   !isDeepStrictEqual(contract.operation_ids,targets.map(t=>t.operation_id))||
   contract.evidence_scope!=="fixed_source_and_local_reproduction_only; actual Immich acceptance remains unverified")bad();
 const urls=sourcePaths.map(p=>"https://github.com/immich-app/immich/blob/"+baseline.commit+"/server/src/"+p);
 if(!Array.isArray(contract.source_urls)||!isDeepStrictEqual(contract.source_urls,urls))bad();
 const method=schemas.PluginMethodResponseDto,plugin=schemas.PluginResponseDto;
 if(!method||!plugin)return bad();
 if(createHash("sha256").update(JSON.stringify(method)).digest("hex")!==methodHash||
   createHash("sha256").update(JSON.stringify(plugin)).digest("hex")!==pluginHash||
   !isDeepStrictEqual(method.properties?.schema,{properties:{},type:"object"})||
   !isDeepStrictEqual(plugin.properties?.methods?.items,{$ref:"#/components/schemas/PluginMethodResponseDto"}))bad();
 for(const t of targets){
  const rows=operations.filter(o=>o.operationId===t.operation_id);if(rows.length!==1)return bad();const o=rows[0]!;
  const ref={$ref:"#/components/schemas/"+(t.method?"PluginMethodResponseDto":"PluginResponseDto")};
  if(o.method!=="GET"||o.path!==t.path||o.definition.operationId!==t.operation_id||
    !isDeepStrictEqual(o.definition.responses?.["200"]?.content?.["application/json"]?.schema,t.array?{items:ref,type:"array"}:ref)||
    o.override?.facts?.some((f:any)=>f.fact_id==="nullable_plugin_method_schema"))bad();
 }
 const privateMethod=structuredClone(method);privateMethod.properties.schema.nullable=true;
 const privatePlugin=structuredClone(plugin);privatePlugin.properties.methods.items=privateMethod;
 return operations.map(o=>{
  if(!targets.some(t=>t.operation_id===o.operationId))return structuredClone(o);
  const t=targets.find(t=>t.operation_id===o.operationId)!,result=structuredClone(o),entry=t.method?privateMethod:privatePlugin;
  result.definition.responses["200"].content["application/json"].schema=t.array?{items:structuredClone(entry),type:"array"}:structuredClone(entry);
  const previous=result.override;
  result.override={...(previous??{operation_id:o.operationId,http_method:"GET",api_relative_path:t.path,
    openapi_operation_pointer:"#/paths/"+t.path.replace(/~/g,"~0").replace(/\//g,"~1")+"/get",runtime_verified:false}),
    facts:[...(previous?.facts??[]),{fact_id:"nullable_plugin_method_schema",evidence_level:"source_verified",
      value:{field:"method.schema",nullable:true,runtime_verified:false,
        observation:"The manifest normalizes empty schema to null, the table is nullable and the DTO mapper returns that stored value."},source_urls:urls}],
    requirements:[...(previous?.requirements??[]),{requirement_id:"private_nullable_plugin_method_schema",evidence_level:"design_requirement",
      value:{status_code:200,content_type:"application/json",private_inline_response:true,global_components_unchanged:true},
      rationale:"Permit null only for the schema field in these three response shapes; preserve all inputs, statuses and other field constraints."}],
    source_urls:[...new Set([...(previous?.source_urls??[]),...urls])]};
  return result;
 });
}
