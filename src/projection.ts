import { registry } from "./registry.js";
import { validator } from "./schema.js";
const branches=new WeakMap<Schema,ReturnType<typeof validator>>();
function matches(value:any,schema:Schema){
  let check=branches.get(schema);if(!check){check=validator(schema,registry.schemas);branches.set(schema,check);}
  try{check(value);return true;}catch{return false;}
}
import { BridgeError, type Schema } from "./types.js";
export function pointer(value:any,path:string) {
  if (path === "") return value;
  if (!path.startsWith("/") || /~(?![01])/u.test(path)) throw new BridgeError("invalid_pointer","Invalid JSON Pointer");
  let v=value;
  for (const token of path.slice(1).split("/").map(t=>t.replace(/~1/g,"/").replace(/~0/g,"~"))) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v,token)) throw new BridgeError("invalid_pointer","Pointer unavailable");
    v=v[token];
  }
  return v;
}
function replacePattern(value:any,pattern:string,replace:(v:string)=>any) {
  const tokens = pattern.slice(1).split("/").map(t=>t.replace(/~1/g,"/").replace(/~0/g,"~"));
  const walk = (node:any,index:number) => {
    if (node === null || node === undefined) return;
    const token = tokens[index]!;
    if (token === "*") {
      if (!Array.isArray(node)) throw new BridgeError("projection_mismatch","Expected array in secret projection");
      for (const child of node) walk(child,index+1);
    } else {
      if (typeof node !== "object" || Array.isArray(node)) throw new BridgeError("projection_mismatch","Unexpected secret container");
      if (!Object.hasOwn(node,token) || node[token] === null) return;
      if (index === tokens.length-1) {
        if (typeof node[token] !== "string") throw new BridgeError("projection_mismatch","Unexpected secret type");
        node[token]=replace(node[token]);
      } else walk(node[token],index+1);
    }
  };
  walk(value,0);
}
export function redact(operationId:string,status:number,value:any,saveSecret:(value:string)=>string,record=false) {
  const display=structuredClone(value);
  for (const rule of registry.secretRules) for (const binding of rule.bindings) {
    if (binding.operation_id !== operationId || binding.direction !== "response" ||
        binding.status_code !== undefined && Number(binding.status_code) !== status ||
        (binding.container === "each_jsonl_record") !== record) continue;
    if (binding.when && pointer(value,binding.when.instance_pointer) !== binding.when.equals) continue;
    replacePattern(display,binding.instance_pointer_pattern,secret=>({secret_ref:saveSecret(secret)}));
  }
  return display;
}
// Unknown response fields stay in the encrypted original, not in model output.
function unknown(value:any,withhold?:((value:any)=>any)){
  if(withhold)return withhold(value);
  throw new BridgeError("projection_mismatch","Unspecified structure withheld");
}
// An explicit empty properties map is still an open arbitrary object in OpenAPI.
// Keep it opaque, exactly like an object without properties. Closed/constrained
// object schemas continue through their existing validation path.
export function unreviewedObject(schema:Schema){
  return !schema.properties || Object.keys(schema.properties).length===0&&
    (schema.additionalProperties===undefined||schema.additionalProperties===true)&&
    !schema.required?.length&&schema.minProperties===undefined&&schema.maxProperties===undefined&&!schema.enum;
}
export function safeShape(value:any,schema:Schema,depth=0,withholdUnknown?:((value:any)=>any)): any {
  if (depth>100) throw new BridgeError("projection_mismatch","Response too deeply nested");
  if (value === null) return null;
  if (schema.$ref) return safeShape(value,registry.schemas[schema.$ref.split("/").at(-1)!]!,depth+1,withholdUnknown);
  if (schema.allOf) {
    const merged:Schema={type:"object",properties:{}};
    for (const s of schema.allOf) {
      const resolved=s.$ref ? registry.schemas[s.$ref.split("/").at(-1)!]! : s;
      Object.assign(merged.properties,resolved.properties ?? {});
      for(const key of ["additionalProperties","minProperties","maxProperties"])if(resolved[key]!==undefined&&!(key==="additionalProperties"&&merged[key]===false))merged[key]=resolved[key];
    }
    return safeShape(value,merged,depth+1,withholdUnknown);
  }
  if (schema.oneOf || schema.anyOf) {
    const candidates=(schema.oneOf ?? schema.anyOf).filter((s:Schema)=>matches(value,s));
    if(schema.oneOf && candidates.length!==1)throw new BridgeError("projection_mismatch","Response union does not identify one branch");
    for(const candidate of candidates){
      try{return safeShape(value,candidate,depth+1,withholdUnknown);}catch(error){
        if(!(error instanceof BridgeError) || error.code!=="projection_mismatch")throw error;
      }
    }
    throw new BridgeError("projection_mismatch","No complete known response branch");
  }
  if(!schema.type&&!schema.enum&&!schema.properties&&!schema.items)return unknown(value,withholdUnknown);
  if (Array.isArray(value)) {
    if (!schema.items) return unknown(value,withholdUnknown);
    return value.map(v=>safeShape(v,schema.items,depth+1,withholdUnknown));
  }
  if (typeof value === "object") {
    if (unreviewedObject(schema)) {
      if(schema.properties&&Object.keys(schema.properties).length===0&&Object.keys(value).length===0)return {};
      return unknown(value,withholdUnknown);
    }
    const out:Record<string,any>={};
    for (const [key,v] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties,key)) throw new BridgeError("projection_mismatch","Unknown field withheld");
      out[key]=safeShape(v,schema.properties[key],depth+1,withholdUnknown);
    }
    return out;
  }
  return value;
}
