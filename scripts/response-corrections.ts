import { isDeepStrictEqual } from "node:util";
import type { Operation,Schema } from "../src/types.js";

interface Fingerprint { version:string;commit:string;sha256:string; }
// Corrections copy only an explicitly identified existing JSON DTO. Unknown
// statuses never inherit a schema, and source-status secrets need target bindings.
export function applyResponseCorrections(operations:Operation[],schemas:Record<string,Schema>,secretRules:Schema[],contract:any,baseline:Fingerprint):Operation[]{
  if(contract?.format!=="immich-mcp-json-response-corrections"||contract.version!==1||
    contract.immich_version!==baseline.version||contract.source_commit!==baseline.commit||contract.openapi_sha256!==baseline.sha256||
    !Array.isArray(contract.corrections))throw Error("Response correction fingerprint mismatch");
  const pending:{op:Operation;row:any;schema:Schema}[]=[],seen=new Set<string>(),seenFacts=new Set<string>();
  const allowed=new Set(["operation_id","http_method","api_relative_path","openapi_operation_pointer","status_code","schema_from_status_code","content_type","schema_ref","fact_id","source_urls"]);
  const allBindings=secretRules.flatMap(rule=>{if(!Array.isArray(rule.bindings))throw Error("Invalid secret rule bindings");return rule.bindings;});
  if(allBindings.some(b=>b.direction==="response"&&b.operation_id==="*"))throw Error("Response correction cannot alter wildcard secret coverage");
  const sourcePattern=new RegExp("^https://github\\.com/immich-app/immich/blob/"+baseline.commit+"/server/src/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.ts$");
  for(const row of contract.corrections){
    const matches=operations.filter(o=>o.operationId===row?.operation_id),op=matches[0],key=row?.operation_id+":"+row?.status_code;
    const pointer=op?"#/paths/"+op.path.replace(/~/g,"~0").replace(/\//g,"~1")+"/"+op.method.toLowerCase():"";
    if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(k=>!allowed.has(k))||matches.length!==1||!op||op.method!==row.http_method||op.path!==row.api_relative_path||pointer!==row.openapi_operation_pointer||
      seen.has(key)||seenFacts.has(row?.operation_id+":"+row?.fact_id)||!Number.isInteger(row.status_code)||row.status_code<200||row.status_code>299||
      !Number.isInteger(row.schema_from_status_code)||row.schema_from_status_code<200||row.schema_from_status_code>299||
      row.status_code===row.schema_from_status_code||row.content_type!=="application/json"||
      Object.hasOwn(op.definition.responses,String(row.status_code))||
      typeof row.fact_id!=="string"||!/^[a-z][a-z0-9_]{1,79}$/.test(row.fact_id)||!Array.isArray(row.source_urls)||!row.source_urls.length||
      new Set(row.source_urls).size!==row.source_urls.length||row.source_urls.some((url:unknown)=>typeof url!=="string"||!sourcePattern.test(url)))
      throw Error("Stale, duplicate or invalid response correction");
    const schema=op.definition.responses[String(row.schema_from_status_code)]?.content?.[row.content_type]?.schema;
    if(!schema||Object.keys(schema).length!==1||schema.$ref!==row.schema_ref||
      typeof row.schema_ref!=="string"||!/^#\/components\/schemas\/[A-Za-z0-9_]+$/.test(row.schema_ref)||
      !Object.hasOwn(schemas,row.schema_ref.slice("#/components/schemas/".length)))
      throw Error("Response correction DTO mismatch");
    const bindings=allBindings.filter(b=>b.operation_id===op.operationId&&b.direction==="response");
    for(const binding of bindings.filter(b=>b.status_code!==undefined&&Number(b.status_code)===row.schema_from_status_code)){
      const withoutStatus=({...value}:any)=>{delete value.status_code;return value;};
      if(!bindings.some(b=>b.status_code!==undefined&&Number(b.status_code)===row.status_code&&isDeepStrictEqual(withoutStatus(b),withoutStatus(binding))))
        throw Error("Response correction lacks target-status secret coverage");
    }
    if(op.override?.facts?.some((fact:any)=>fact.fact_id===row.fact_id))throw Error("Duplicate response correction fact");
    seen.add(key);seenFacts.add(row.operation_id+":"+row.fact_id);pending.push({op,row,schema});
  }
  const result=operations.map(o=>({...o}));
  for(const {op,row,schema} of pending){
    const target=result.find(o=>o.operationId===op.operationId)!;
    // Do not modify the parsed original OpenAPI or a caller-held schema.
    target.definition={...target.definition,responses:{...target.definition.responses,[String(row.status_code)]:{
      description:"Fixed-source verified success response",content:{[row.content_type]:{schema:structuredClone(schema)}}
    }}};
    const override=target.override?structuredClone(target.override):{
      operation_id:op.operationId,http_method:op.method,api_relative_path:op.path,openapi_operation_pointer:row.openapi_operation_pointer,
      facts:[],requirements:[],source_urls:[]
    };
    override.facts.push({fact_id:row.fact_id,evidence_level:"source_verified",value:{
      status_code:row.status_code,schema_from_status_code:row.schema_from_status_code,content_type:row.content_type,schema_ref:row.schema_ref,
      runtime_verified:false
    },source_urls:[...row.source_urls]});
    override.source_urls=[...new Set([...override.source_urls,...row.source_urls])];target.override=override;
  }
  return result;
}
