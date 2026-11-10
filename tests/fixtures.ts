import { registry } from "../src/registry.js";
import type { ApiCall, Schema, Operation } from "../src/types.js";
import { pointer } from "../src/projection.js";
export const uuid="11111111-1111-4111-8111-111111111111";
export function sample(s:Schema):any {
  if (s.$ref) return sample(registry.schemas[s.$ref.split("/").at(-1)!]!);
  if (s.enum) return s.enum[0];
  if (s.example !== undefined) return structuredClone(s.example);
  if (s.allOf) return Object.assign({},...s.allOf.map(sample));
  if (s.anyOf || s.oneOf) return sample((s.anyOf ?? s.oneOf)[0]);
  if (s.type === "array") return Array.from({length:s.minItems ?? 1},()=>sample(s.items));
  if (s.type === "object" || s.properties) return Object.fromEntries((s.required ?? []).map((k:string)=>[k,sample(s.properties[k])]));
  if (s.type === "boolean") return false;
  if (s.type === "integer" || s.type === "number") return Math.max(s.minimum ?? 0, s.exclusiveMinimum === true ? (s.minimum ?? 0)+1 : 0);
  if (s.pattern?.includes("seg_")) return "seg_0.m4s";
  if (s.format === "uuid") return s.pattern?.includes("-7[") ? uuid.replace("-4111-", "-7111-") : uuid;
  if (s.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (s.format === "date") return "2026-01-01";
  if (s.format === "email" || s.pattern?.includes("@")) return "test@example.com";
  if (s.format === "uri" || s.format === "url") return "https://example.com/test";
  if (s.pattern?.includes("[01]")) return "12:34";
  if (s.pattern?.includes("IM(SV|CL)")) return "IMSV" + "-ABCD".repeat(8);
  if (s.pattern?.includes("#?")) return "#112233";
  if (s.pattern?.includes("6}")) return "123456";
  return "x".repeat(Math.max(1,s.minLength ?? 1));
}
export function fixture(op:Operation):ApiCall {
  const call:ApiCall={operation_id:op.operationId};
  for (const p of op.parameters.filter(p=>p.required)) {
    const key=p.in === "header" ? "headers" : p.in as "path"|"query";
    call[key] ??= {};
    call[key]![p.name]=sample(p.schema);
  }
  const [mime,media] = Object.entries<any>(op.definition.requestBody?.content ?? {})[0] ?? [];
  if (mime) {
    call.content_type=mime;
    call.body=sample(media.schema);
    if (mime === "multipart/form-data") {
      const schema = media.schema.$ref ? registry.schemas[media.schema.$ref.split("/").at(-1)!]! : media.schema;
      call.files={};
      for (const key of schema.required ?? []) if (schema.properties[key].format==="binary") {
        call.files[key]={file_ref:"file_fixture"}; delete call.body[key];
      }
    }
  }
  for(const rule of registry.secretRules.flatMap(r=>r.bindings).filter(b=>b.operation_id===op.operationId && b.direction==="request")){
    let value:any;try{value=pointer(call.body,rule.instance_pointer_pattern);}catch{continue;}
    if(value===undefined || value===null)continue;
    const tokens=rule.instance_pointer_pattern.slice(1).split("/");
    let parent=call.body;
    for(const key of tokens.slice(0,-1))parent=parent[key];
    delete parent[tokens.at(-1)!];
    call.secret_bindings ??= [];
    call.secret_bindings.push({location:"body",pointer:rule.instance_pointer_pattern,secret_ref:"secret_fixture"});
  }
  return call;
}
export function resolvedBody(call:ApiCall) {
  const body=structuredClone(call.body);
  for(const binding of call.secret_bindings ?? []){
    const tokens=binding.pointer.slice(1).split("/");let parent=body;
    for(const key of tokens.slice(0,-1)){parent[key] ??= {};parent=parent[key];}
    parent[tokens.at(-1)!]=binding.pointer.toLowerCase().includes("pincode")?"123456":"secret-fixture";
  }
  return body;
}
