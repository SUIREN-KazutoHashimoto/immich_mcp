import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { BridgeError, type ApiCall, type Operation, type Schema } from "./types.js";
import { assertSafeNumbers, validator } from "./schema.js";
import { operation, registry } from "./registry.js";
import { pointer } from "./projection.js";

const authHeaders = new Set(["authorization","proxy-authorization","cookie","x-api-key","x-immich-user-token","x-immich-session-token","x-immich-share-key","x-immich-share-slug","cf-access-jwt-assertion","cf-access-client-secret"]);
const authQuery = new Set(["apikey","sessionkey","key","slug"]);
const envelope = new Set(["operation_id","path","query","headers","content_type","body","files","secret_bindings","result_mode","execution_mode"]);
const enc = (v: any) => encodeURIComponent(v === null ? "" : String(v)).replace(/[!'()*]/g, c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
const flat = (v: any, encode: (v:any)=>string) => Object.entries(v).flatMap(([k,x])=>[encode(k),encode(x)]);
function parameter(p: Schema, value: any): [string,string][] {
  const style = p.style ?? (p.in === "query" ? "form" : "simple");
  const explode = p.explode ?? (style === "form");
  const name = enc(p.name);
  if (p.in === "query") {
    if (style === "deepObject") {
      if (!value || Array.isArray(value) || typeof value !== "object") throw new BridgeError("invalid_input","deepObject requires object");
      return Object.entries(value).map(([k,v])=>[name+"%5B"+enc(k)+"%5D",enc(v)]);
    }
    if (Array.isArray(value)) {
      if (style === "form" && explode) return value.map(v=>[name,enc(v)]);
      const sep = style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "%7C" : ",";
      return [[name,value.map(enc).join(sep)]];
    }
    if (value && typeof value === "object") return explode ? Object.entries(value).map(([k,v])=>[enc(k),enc(v)]) : [[name,flat(value,enc).join(",")]];
    return [[name,enc(value)]];
  }
  const encode = p.in === "header" ? (v:any)=>v === null ? "" : String(v) : enc;
  let text = Array.isArray(value) ? value.map(encode).join(style === "label" && explode ? "." : ",") :
    value && typeof value === "object" ? (explode ? Object.entries(value).map(([k,v])=>encode(k)+"="+encode(v)) : flat(value,encode)).join(style === "label" && explode ? "." : ",") : encode(value);
  if (style === "label") text = "." + text;
  if (style === "matrix") {
    text = Array.isArray(value) && explode ? value.map(v=>";"+name+"="+enc(v)).join("") :
      value && typeof value === "object" && explode ? Object.entries(value).map(([k,v])=>";"+enc(k)+"="+enc(v)).join("") : ";"+name+"="+text;
  }
  return [[p.name,text]];
}
export interface FilePart { filename: string; mime: string; size: number; open: () => AsyncIterable<Uint8Array>; validate?:()=>void; }
export interface Resolver {
  validate?:()=>void;
  file(ref: string): Promise<FilePart>;
  secret(ref: string, location: string, pointer: string): Promise<any>;
}
export interface Prepared { operation: Operation; url: URL; method: string; headers: Headers; body?: BodyInit | AsyncIterable<Uint8Array>; validateResources:()=>void; }
function setPointer(value: any, pointer: string, secret: any) {
  if (!pointer.startsWith("/")) throw new BridgeError("invalid_secret_binding","Expected JSON Pointer");
  const tokens = pointer.slice(1).split("/").map(t=>t.replace(/~1/g,"/").replace(/~0/g,"~"));
  let current = value;
  for (const token of tokens.slice(0,-1)) {
    if (["__proto__","constructor","prototype"].includes(token)) throw new BridgeError("invalid_secret_binding","Invalid pointer");
    if (!Object.hasOwn(current,token)) current[token] = {};
    current = current[token];
  }
  const key = tokens.at(-1)!;
  if (["__proto__","constructor","prototype"].includes(key)) throw new BridgeError("invalid_secret_binding","Invalid pointer");
  current[key] = secret;
}
export async function prepare(base: string, input: ApiCall, resolver?: Resolver): Promise<Prepared> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k=>!envelope.has(k)))
    throw new BridgeError("invalid_envelope","Unknown call field");
  const op = operation(input.operation_id);
  assertSafeNumbers(input);
  const call = structuredClone(input);
  for (const location of ["path","query","headers"] as const) {
    const args = call[location] ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("invalid_input","Invalid parameter map");
    for (const name of Object.keys(args)) {
      if ((location === "headers" && authHeaders.has(name.toLowerCase())) || (location === "query" && authQuery.has(name.toLowerCase())))
        throw new BridgeError("auth_injection","Authentication input requires a dedicated context");
    }
  }
  const requestSecrets=registry.secretRules.flatMap(r=>r.bindings).filter(b=>b.operation_id===op.operationId && b.direction==="request");
  for(const rule of requestSecrets) {
    let value:any;
    try { value=pointer(call.body,rule.instance_pointer_pattern); } catch { continue; }
    if(value!==null && value!==undefined) throw new BridgeError("secret_reference_required","Use a control-UI secret reference for sensitive input");
  }
  const targets=new Set<string>();
  for (const binding of call.secret_bindings ?? []) {
    const target=binding.location+":"+binding.pointer;
    if(targets.has(target)) throw new BridgeError("invalid_secret_binding","Duplicate secret target");
    targets.add(target);
    const rules = registry.secretRules.flatMap(r=>r.bindings).filter(b=>b.operation_id === op.operationId &&
      b.direction === "request" && b.instance_pointer_pattern === binding.pointer);
    if (binding.location !== "body" || !rules.length || !resolver) throw new BridgeError("invalid_secret_binding","Binding not permitted");
    call.body ??= {};
    setPointer(call.body,binding.pointer,await resolver.secret(binding.secret_ref,binding.location,binding.pointer));
  }
  let path = op.path;
  const queries: [string,string][] = [];
  const headers = new Headers();
  for (const location of ["path","query","header"]) {
    const args = (location === "header" ? call.headers : location === "path" ? call.path : call.query) ?? {};
    const known = op.parameters.filter(p=>p.in === location);
    for (const name of Object.keys(args)) {
      if (!known.some(p=>location === "header" ? p.name.toLowerCase() === name.toLowerCase() : p.name === name))
        throw new BridgeError("unknown_parameter","Unknown " + location + " parameter");
    }
    for (const p of known) {
      const key = Object.keys(args).find(k=>location === "header" ? k.toLowerCase()===p.name.toLowerCase() : k===p.name);
      if (key === undefined) { if (p.required) throw new BridgeError("missing_parameter","Required parameter missing"); continue; }
      const value = args[key];
      validator(p.schema ?? {},registry.schemas)(value);
      if (location === "path" && [".",".."].includes(String(value))) throw new BridgeError("invalid_path","Dot segment rejected");
      const pairs = parameter(p,value);
      if (location === "path") path = path.replace("{"+p.name+"}",pairs[0]![1]);
      else if (location === "query") queries.push(...pairs);
      else {
        const v = pairs[0]![1];
        if (/[\r\n]/.test(v)) throw new BridgeError("invalid_header","Invalid header value");
        headers.set(p.name,v);
      }
    }
  }
  const origin = new URL(base);
  if (!["http:","https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash)
    throw new BridgeError("invalid_base","Invalid fixed upstream base");
  const url = new URL(origin.toString().replace(/\/$/,"") + path);
  if (url.origin !== origin.origin || !url.pathname.startsWith(origin.pathname.replace(/\/$/,"")+"/"))
    throw new BridgeError("invalid_path","Path escaped fixed upstream base");
  url.search = queries.map(([k,v])=>k+"="+v).join("&");
  const content = op.definition.requestBody?.content ?? {};
  const types = Object.keys(content);
  const hasBody = Object.hasOwn(call,"body");
  if (!types.length && (hasBody || call.files && Object.keys(call.files).length || call.content_type)) throw new BridgeError("unexpected_body","Operation has no body");
  const type = call.content_type ?? (types.length === 1 ? types[0] : undefined);
  if (types.length && !type) throw new BridgeError("content_type","Select a declared content type");
  if (type && !Object.hasOwn(content,type)) throw new BridgeError("content_type","Undeclared content type");
  const resourceChecks:(()=>void)[]=[];
  if(resolver?.validate)resourceChecks.push(()=>resolver.validate!());
  let body: Prepared["body"];
  if (type) {
    const media = content[type];
    let value = call.body;
    if (type === "multipart/form-data") {
      value = hasBody ? structuredClone(call.body) : {};
      if (!value || Array.isArray(value) || typeof value !== "object") throw new BridgeError("invalid_input","Multipart fields require object");
      const schema = media.schema.$ref ? registry.schemas[media.schema.$ref.split("/").at(-1)!]! : media.schema;
      const parts: {name:string; file:FilePart}[] = [];
      for (const [name,ref] of Object.entries(call.files ?? {})) {
        if (schema.properties?.[name]?.format !== "binary" || !resolver) throw new BridgeError("invalid_file","Unknown binary field or missing resolver");
        const file=await resolver.file(ref.file_ref);
        if(file.validate)resourceChecks.push(()=>file.validate!());
        parts.push({name,file});
        value[name] = "__resolved_binary__";
      }
      for (const [name,field] of Object.entries<any>(schema.properties ?? {})) {
        if (field.format === "binary" && Object.hasOwn(value,name) && !parts.some(p=>p.name===name))
          throw new BridgeError("invalid_file","Binary fields require file_ref");
      }
      validator(media.schema,registry.schemas)(value);
      const boundary = "immich-mcp-" + randomUUID();
      headers.set("content-type",type+"; boundary="+boundary);
      const encode = (s:string)=>new TextEncoder().encode(s);
      const quote = (s:string)=>s.replace(/[\r\n"\\]/g,"_");
      body = (async function* () {
        for (const [name,v] of Object.entries(value)) {
          const p = parts.find(p=>p.name===name);
          yield encode("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+quote(name)+"\""+
            (p ? "; filename=\""+quote(p.file.filename)+"\"\r\nContent-Type: "+p.file.mime : "")+"\r\n\r\n");
          if (p) yield* p.file.open();
          else yield encode(v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
          yield encode("\r\n");
        }
        yield encode("--"+boundary+"--\r\n");
      })();
    } else if (hasBody) {
      validator(media.schema ?? {},registry.schemas)(value);
      headers.set("content-type",type);
      if (type === "application/json") body = JSON.stringify(value);
      else if (type === "application/x-www-form-urlencoded") {
        const form: [string,string][] = [];
        for (const [name,v] of Object.entries(value)) form.push(...parameter({name,in:"query",...(media.encoding?.[name] ?? {})},v));
        body = form.map(([k,v])=>k+"="+v).join("&");
      } else throw new BridgeError("content_type","Unsupported declared request media");
    } else if (op.definition.requestBody?.required) throw new BridgeError("missing_body","Required request body missing");
  }
  return {operation:op,url,method:op.method,headers,...(body !== undefined ? {body} : {}),validateResources:()=>resourceChecks.forEach(check=>check())};
}
