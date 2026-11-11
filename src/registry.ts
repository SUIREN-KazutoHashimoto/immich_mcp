import data from "./generated/registry.json" with { type: "json" };
import type { Registry, Operation, Schema } from "./types.js";
import { BridgeError } from "./types.js";
import { convertSchema } from "./schema.js";
export const registry = data as Registry;
const byId = new Map(registry.operations.map(o => [o.operationId, o]));
export function operation(id: string): Operation {
  const op = byId.get(id);
  if (!op) throw new BridgeError("unknown_operation", "Unknown operation");
  return op;
}
export function catalog(input: {query?:string; tag?:string; cursor?:string; limit?:number} = {}) {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError("invalid_cursor", "Invalid page size");
  const scope = JSON.stringify([input.query ?? "", input.tag ?? ""]);
  let offset = 0;
  if (input.cursor) {
    try {
      const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (c.sha !== registry.sha256 || c.scope !== scope || !Number.isSafeInteger(c.offset) || c.offset < 0) throw Error();
      offset = c.offset;
    } catch { throw new BridgeError("invalid_cursor", "Cursor does not belong to this catalog query"); }
  }
  const matches = registry.operations.filter(o => (!input.tag || o.tag === input.tag) &&
    (!input.query || (o.operationId + " " + (o.definition.summary ?? "")).toLowerCase().includes(input.query.toLowerCase())));
  return {total:279, matched:matches.length, source_sha256:registry.sha256,
    entries:matches.slice(offset,offset+limit).map(o=>({operation_id:o.operationId,method:o.method,path:o.path,tag:o.tag,
      summary:o.definition.summary ?? "", auth_requirements:o.auth})),
    next_cursor: offset+limit < matches.length ? Buffer.from(JSON.stringify({sha:registry.sha256,scope,offset:offset+limit})).toString("base64url") : null};
}
export function describe(id: string) {
  const op = operation(id);
  const schemas: Record<string,Schema> = {};
  for (const p of op.parameters) if (p.schema) schemas[p.in + ":" + p.name] = convertSchema(p.schema, registry.schemas);
  for (const [mime, media] of Object.entries<any>(op.definition.requestBody?.content ?? {}))
    schemas["body:" + mime] = convertSchema(media.schema ?? {}, registry.schemas);
  return {operation_id:id, method:op.method,path:op.path, upstream:op.definition,
    components:{schemas:registry.schemas}, input_schemas:schemas,auth_requirements:op.auth, secret_rules:registry.secretRules.filter(r=>r.bindings.some((b:any)=>b.operation_id===id)), overrides:op.override ?? null};
}
export function referencedSchemas(values:unknown[],schemas:Record<string,Schema>=registry.schemas){
  const selected:Record<string,Schema>=Object.create(null);
  const visit=(value:any):void=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(!value||typeof value!=="object")return;
    for(const [key,item]of Object.entries(value)){
      if(key==="$ref"&&typeof item==="string"&&item.startsWith("#/components/schemas/")){
        const name=item.slice("#/components/schemas/".length);
        if(!Object.hasOwn(schemas,name))throw new BridgeError("schema_reference","Referenced schema is unavailable");
        if(!Object.hasOwn(selected,name)){selected[name]=schemas[name]!;visit(schemas[name]);}
      }else visit(item);
    }
  };
  for(const value of values)visit(value);
  return selected;
}
