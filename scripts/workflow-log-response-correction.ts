import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Operation,Schema} from "../src/types.js";

export interface WorkflowLogIndexBaseline {version:string;commit:string;sha256:string;}
const component="WorkflowLogEntryDto",operationId="getWorkflowLogs",path="/workflows/{id}/logs";
const componentHash="6701a6a67fd6a8cf08f1162e6ccba74243bd1a1fa68632c23087e5799b324543";
const allowedKeys=["format","version","immich_version","source_commit","openapi_sha256","operation_id","http_method",
  "api_relative_path","openapi_operation_pointer","status_code","content_type","component_name","component_sha256",
  "component_property_pointer","source_urls","evidence_scope"];
const factId="workflow_log_zero_based_step_index";
const requirementId="workflow_log_index_private_response_schema";
export function applyWorkflowLogIndexCorrection(operations:Operation[],schemas:Record<string,Schema>,contract:any,
  baseline:WorkflowLogIndexBaseline):Operation[]{
  const bad=()=>{throw Error("Stale or invalid workflow log index response correction");};
  if(!contract||typeof contract!=="object"||Array.isArray(contract)||Object.keys(contract).some(k=>!allowedKeys.includes(k))||
    contract.format!=="immich-mcp-workflow-log-index-correction"||contract.version!==1||
    baseline.version!=="3.3.5"||baseline.commit!=="8303cb117e197c700332b33b61b45314c9cc5bb4"||
    baseline.sha256!=="632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9"||
    contract.immich_version!==baseline.version||contract.source_commit!==baseline.commit||contract.openapi_sha256!==baseline.sha256||
    contract.operation_id!==operationId||contract.http_method!=="GET"||contract.api_relative_path!==path||
    contract.openapi_operation_pointer!=="#/paths/~1workflows~1{id}~1logs/get"||
    contract.status_code!==200||contract.content_type!=="application/json"||contract.component_name!==component||
    contract.component_sha256!==componentHash||contract.component_property_pointer!=="/properties/lastStep/properties/index"||
    contract.evidence_scope!=="fixed_source_and_local_reproduction_only; actual Immich acceptance remains unverified")bad();
  const requiredSources=["controllers/workflow.controller.ts","services/workflow.service.ts","repositories/workflow.repository.ts",
    "dtos/workflow.dto.ts","services/workflow-execution.service.ts"].map(p=>
      "https://github.com/immich-app/immich/blob/"+baseline.commit+"/server/src/"+p);
  if(!Array.isArray(contract.source_urls)||contract.source_urls.length!==requiredSources.length||
    new Set(contract.source_urls).size!==requiredSources.length||requiredSources.some(s=>!contract.source_urls.includes(s)))bad();
  const original=schemas[component];
  if(!original)return bad();
  if(createHash("sha256").update(JSON.stringify(original)).digest("hex")!==componentHash)bad();
  const index=original.properties?.lastStep?.properties?.index;
  if(index?.type!=="integer"||index.minimum!==0||index.exclusiveMinimum!==true||index.maximum!==Number.MAX_SAFE_INTEGER)bad();
  const targets=operations.filter(o=>o.operationId===operationId);if(targets.length!==1)bad();
  const input=targets[0]!;
  const expected={items:{$ref:"#/components/schemas/"+component},type:"array"};
  if(input.method!=="GET"||input.path!==path||input.definition.operationId!==operationId||
    !isDeepStrictEqual(input.definition.responses?.["200"]?.content?.["application/json"]?.schema,expected)||
    input.override?.facts?.some((f:any)=>f.fact_id===factId)||input.override?.requirements?.some((r:any)=>r.requirement_id===requirementId))bad();
  const result=operations.map(o=>structuredClone(o)),target=result.find(o=>o.operationId===operationId)!;
  const privateEntry=structuredClone(original);
  delete privateEntry.properties.lastStep.properties.index.exclusiveMinimum;
  target.definition.responses["200"].content["application/json"].schema.items=privateEntry;
  const previous=target.override;
  target.override={...(previous??{operation_id:operationId,http_method:"GET",api_relative_path:path,
      openapi_operation_pointer:contract.openapi_operation_pointer,runtime_verified:false}),
    facts:[...(previous?.facts??[]),{fact_id:factId,evidence_level:"source_verified",
      value:{component,field:"lastStep.index",minimum:0,maximum:Number.MAX_SAFE_INTEGER,runtime_verified:false,
        observation:"Repository step order starts at0 and the execution service logs an early-exit step by that stored ID."},
      source_urls:contract.source_urls}],
    requirements:[...(previous?.requirements??[]),{requirement_id:requirementId,evidence_level:"design_requirement",
      value:{status_code:200,content_type:"application/json",private_inline_entry:true,component_global_unchanged:true,
        minimum:0,integer:true},rationale:"Allow only zero-based log step indexes in this response; keep all inputs, statuses, other fields and global components unchanged."}],
    source_urls:[...new Set([...(previous?.source_urls??[]),...contract.source_urls])]};
  return result;
}
