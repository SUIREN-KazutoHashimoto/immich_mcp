import { isDeepStrictEqual } from "node:util";
import type { Operation,Schema } from "../src/types.js";
interface Fingerprint {version:string;commit:string;sha256:string;}
const originalSchema={type:"array",items:{type:"string"}};
// This correction is deliberately limited to an inline string array. It cannot
// replace arbitrary schemas, inherit unknown statuses or alter secret responses.
export function applyResponseShapeCorrections(operations:Operation[],secretRules:Schema[],contract:any,baseline:Fingerprint):Operation[]{
  if(contract?.format!=="immich-mcp-json-response-shape-corrections"||contract.version!==1||
    contract.immich_version!==baseline.version||contract.source_commit!==baseline.commit||contract.openapi_sha256!==baseline.sha256||
    !Array.isArray(contract.corrections))throw Error("Response shape correction fingerprint mismatch");
  const allowed=new Set(["operation_id","http_method","api_relative_path","openapi_operation_pointer","status_code","content_type","schema_pointer","correction","expected_schema","fact_id","source_urls"]);
  const bindings=secretRules.flatMap(rule=>{if(!Array.isArray(rule.bindings))throw Error("Invalid secret rule bindings");return rule.bindings;});
  const seen=new Set<string>(),facts=new Set<string>(),pending:{op:Operation;row:any}[]=[];
  const sourcePattern=new RegExp("^https://github\\.com/immich-app/immich/blob/"+baseline.commit+"/server/src/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.ts$");
  for(const row of contract.corrections){
    const matches=operations.filter(o=>o.operationId===row?.operation_id),op=matches[0],key=row?.operation_id+":"+row?.status_code;
    const pointer=op?"#/paths/"+op.path.replace(/~/g,"~0").replace(/\//g,"~1")+"/"+op.method.toLowerCase():"";
    if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(key=>!allowed.has(key))||
      matches.length!==1||!op||op.method!==row.http_method||op.path!==row.api_relative_path||pointer!==row.openapi_operation_pointer||
      seen.has(key)||facts.has(row.operation_id+":"+row.fact_id)||!Number.isInteger(row.status_code)||row.status_code<200||row.status_code>299||
      row.content_type!=="application/json"||row.schema_pointer!=="/items"||row.correction!=="allow_null_string_array_items"||
      !isDeepStrictEqual(row.expected_schema,originalSchema)||typeof row.fact_id!=="string"||!/^[a-z][a-z0-9_]{1,79}$/.test(row.fact_id)||
      !Array.isArray(row.source_urls)||!row.source_urls.length||new Set(row.source_urls).size!==row.source_urls.length||
      row.source_urls.some((url:unknown)=>typeof url!=="string"||!sourcePattern.test(url)))
      throw Error("Stale, duplicate or invalid response shape correction");
    const schema=op.definition.responses[String(row.status_code)]?.content?.[row.content_type]?.schema;
    if(!isDeepStrictEqual(schema,originalSchema))throw Error("Response shape correction schema mismatch");
    if(bindings.some(b=>b.direction==="response"&&(b.operation_id===op.operationId||b.operation_id==="*")))
      throw Error("Response shape correction cannot alter secret-bearing responses");
    if(op.override?.facts?.some((fact:any)=>fact.fact_id===row.fact_id))throw Error("Duplicate response shape correction fact");
    seen.add(key);facts.add(row.operation_id+":"+row.fact_id);pending.push({op,row});
  }
  const result=operations.map(op=>({...op}));
  for(const {op,row} of pending){
    const target=result.find(o=>o.operationId===op.operationId)!,status=String(row.status_code),response=target.definition.responses[status],media=response.content[row.content_type];
    const correctedSchema={...structuredClone(media.schema),items:{...structuredClone(media.schema.items),nullable:true}};
    target.definition={...target.definition,responses:{...target.definition.responses,[status]:{
      ...response,content:{...response.content,[row.content_type]:{...media,schema:correctedSchema}}
    }}};
    const override=target.override?structuredClone(target.override):{
      operation_id:op.operationId,http_method:op.method,api_relative_path:op.path,openapi_operation_pointer:row.openapi_operation_pointer,
      facts:[],requirements:[],source_urls:[]
    };
    override.facts.push({fact_id:row.fact_id,evidence_level:"source_verified",value:{
      status_code:row.status_code,content_type:row.content_type,correction:row.correction,schema_pointer:row.schema_pointer,
      expected_schema:structuredClone(originalSchema),corrected_schema:structuredClone(correctedSchema),runtime_verified:false
    },source_urls:row.source_urls});
    override.source_urls=[...new Set([...override.source_urls,...row.source_urls])];target.override=override;
  }
  return result;
}
