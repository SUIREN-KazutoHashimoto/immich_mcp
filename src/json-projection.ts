import { randomUUID } from "node:crypto";
import { parser,type Token } from "stream-json/parser.js";
import { registry } from "./registry.js";
import { validator,assertSafeNumbers } from "./schema.js";
import { safeShape,unreviewedObject } from "./projection.js";
import { BridgeError,type Schema } from "./types.js";
import { JsonTree,type JsonNode,type JsonEntry,type JsonProjectionMeta } from "./json-tree.js";
import { Vault } from "./vault.js";
const withheld=()=>({withheld:true,reason:"unreviewed_structure",original_available_in_control_ui:true});
const resolved=new WeakMap<Schema,Schema>(),checks=new WeakMap<Schema,ReturnType<typeof validator>>();
function shape(schema:Schema,depth=0):Schema{
  if(depth>100)throw new BridgeError("response_schema_limit","Response schema is too deep");
  const cached=resolved.get(schema);if(cached)return cached;
  const sources:Schema[]=[];
  if(schema.$ref)sources.push(shape(registry.schemas[schema.$ref.split("/").at(-1)!]!,depth+1));
  for(const branch of schema.allOf ?? [])sources.push(shape(branch,depth+1));
  const own={...schema};delete own.$ref;delete own.allOf;sources.push(own);
  const output:Schema={};let properties:Schema|undefined,required:string[]=[];
  for(const source of sources){
    Object.assign(output,source);
    if(source.properties)properties={...properties,...source.properties};
    if(source.required)required.push(...source.required);
  }
  if(properties)output.properties=properties;
  if(required.length)output.required=[...new Set(required)];
  resolved.set(schema,output);return output;
}
function check(value:any,schema:Schema){
  let fn=checks.get(schema);if(!fn){fn=validator(schema,registry.schemas);checks.set(schema,fn);}fn(value);
}
interface Frame {kind:"object"|"array";id:string;schema:Schema;path:string[];count:number;entries:JsonEntry[];bytes:number;flushed:boolean;keys:Set<string>;key?:string;}
interface CaptureFrame {kind:"object"|"array";value:any;keys:Set<string>;key?:string;}
export class JsonProjection {
  readonly tree:JsonTree;
  readonly maxValueBytes:number;
  private readonly tokenizer=parser.asStream({packValues:false,streamValues:true,jsonStreaming:false});
  private decoder=new TextDecoder("utf-8",{fatal:true});
  private frames:Frame[]=[];private root?:JsonNode;private depth=0;private skipDepth=0;private skipPreserveEmptyObject=false;
  private lex?:{kind:"key"|"string"|"number";text:string;bytes:number;ignore:boolean};
  private capture?:{schema:Schema;path:string[];frames:CaptureFrame[];bytes:number};
  private error:string|null=null;private ended=false;private completion:Promise<void>;
  private bindings:{tokens:string[]}[];
  constructor(vault:Vault,principal:string,readonly schema:Schema,operation:string,status:number,readonly saveSecret:(value:string)=>string,
    expires=Date.now()+3600_000,maxValueBytes=1024*1024){
    this.tree=new JsonTree(vault,principal,expires);this.maxValueBytes=maxValueBytes;
    this.bindings=registry.secretRules.flatMap(rule=>rule.bindings)
      .filter(b=>b.operation_id===operation&&b.direction==="response"&&b.container!=="each_jsonl_record"&&(b.status_code===undefined||Number(b.status_code)===status))
      .map(b=>{if(b.when)throw new BridgeError("response_schema_limit","Conditional response rule needs an adapter");
        return {tokens:b.instance_pointer_pattern.slice(1).split("/").map((t:string)=>t.replace(/~1/g,"/").replace(/~0/g,"~"))};});
    this.completion=new Promise(resolve=>{
      this.tokenizer.once("end",resolve);this.tokenizer.once("close",resolve);
      this.tokenizer.on("error",()=>{this.error ??= "invalid_json_response";resolve();});
    });
    this.tokenizer.on("data",(token:Token)=>{if(this.error)return;try{this.token(token);}catch(error){this.fail(error);}});
  }
  private fail(error:unknown){this.error ??= error instanceof BridgeError?error.code:"invalid_json_response";this.tokenizer.destroy();}
  private place():{schema:Schema;path:string[]}{
    const parent=this.frames.at(-1);
    if(!parent)return {schema:this.schema,path:[]};
    const key=parent.kind==="array"?String(parent.count):parent.key;
    if(key===undefined)throw new BridgeError("invalid_json_response","Missing object key");
    const s=shape(parent.schema);
    if(parent.kind==="array")return {schema:s.items ?? {},path:[...parent.path,key]};
    if(!Object.hasOwn(s.properties ?? {},key))throw new BridgeError("projection_mismatch","Unknown response field withheld");
    return {schema:s.properties[key],path:[...parent.path,key]};
  }
  private isSecret(path:string[]){return this.bindings.some(b=>b.tokens.length===path.length&&b.tokens.every((t,i)=>t==="*"||t===path[i]));}
  private small(value:any,path:string[]):any{
    if(value===null)return null;
    if(this.isSecret(path)){
      if(typeof value!=="string")throw new BridgeError("projection_mismatch","Unexpected secret field type");
      return {secret_ref:this.saveSecret(value)};
    }
    if(Array.isArray(value))return value.map((v,i)=>this.small(v,[...path,String(i)]));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.small(v,[...path,k])]));
    return value;
  }
  private flush(frame:Frame){
    if(!frame.entries.length)return;
    this.tree.write(frame.id,frame.count-frame.entries.length,frame.entries);
    frame.entries=[];frame.bytes=0;frame.flushed=true;
  }
  private emit(node:JsonNode){
    const parent=this.frames.at(-1);
    if(!parent){if(this.root)throw new BridgeError("invalid_json_response","Multiple JSON roots");this.root=node;return;}
    const key=parent.kind==="array"?String(parent.count):parent.key!;
    const entry={key,node},size=Buffer.byteLength(JSON.stringify(entry));
    if(parent.entries.length&&(parent.entries.length>=64||parent.bytes+size>128*1024))this.flush(parent);
    parent.entries.push(entry);parent.bytes+=size;parent.count++;parent.key=undefined;
    if(parent.bytes>128*1024)this.flush(parent);
  }
  private start(kind:"object"|"array"){
    if(++this.depth>100)throw new BridgeError("response_depth_limit","JSON exceeds configured depth limit");
    if(this.skipDepth){this.skipPreserveEmptyObject=false;this.skipDepth++;return;}
    if(this.capture){this.capture.bytes+=64;this.captureLimit();this.capture.frames.push({kind,value:kind==="array"?[]:Object.create(null),keys:new Set()});return;}
    const location=this.place(),s=shape(location.schema);
    if(s.oneOf||s.anyOf){
      this.capture={...location,frames:[{kind,value:kind==="array"?[]:Object.create(null),keys:new Set()}],bytes:64};return;
    }
    if(s.type&&s.type!==kind)throw new BridgeError("response_schema_mismatch","Unexpected JSON container type");
    if(kind==="object"&&unreviewedObject(s)||kind==="array"&&!s.items){
      this.skipDepth=1;this.skipPreserveEmptyObject=kind==="object"&&!!s.properties&&Object.keys(s.properties).length===0;return;
    }
    this.frames.push({kind,id:randomUUID(),schema:location.schema,path:location.path,count:0,entries:[],bytes:0,flushed:false,keys:new Set()});
  }
  private captureLimit(){if(this.capture!.bytes>this.maxValueBytes)throw new BridgeError("json_value_limit","Response union exceeds configured inspection limit");}
  private captureValue(value:any){
    this.capture!.bytes+=16;this.captureLimit();
    const f=this.capture!.frames.at(-1)!;
    if(f.kind==="array")f.value.push(value);
    else {if(f.key===undefined)throw new BridgeError("invalid_json_response","Missing captured key");Object.defineProperty(f.value,f.key,{value,enumerable:true,configurable:true,writable:true});f.key=undefined;}
  }
  private end(kind:"object"|"array"){
    this.depth--;
    if(this.skipDepth){
      if(--this.skipDepth===0){const value=this.skipPreserveEmptyObject?{}:withheld();this.skipPreserveEmptyObject=false;this.emit({kind:"value",value});}return;
    }
    if(this.capture){
      const frame=this.capture.frames.pop()!;
      if(frame.kind!==kind)throw new BridgeError("invalid_json_response","Mismatched JSON container");
      if(this.capture.frames.length){this.captureValue(frame.value);return;}
      const capture=this.capture;this.capture=undefined;check(frame.value,capture.schema);
      this.emit({kind:"value",value:this.small(safeShape(frame.value,capture.schema,0,withheld),capture.path)});return;
    }
    const frame=this.frames.pop()!;
    if(frame.kind!==kind)throw new BridgeError("invalid_json_response","Mismatched JSON container");
    const s=shape(frame.schema);
    if(kind==="object"&&(s.required ?? []).some((key:string)=>!frame.keys.has(key)))throw new BridgeError("response_schema_mismatch","Required response field is absent");
    if(kind==="array"&&(s.minItems!==undefined&&frame.count<s.minItems||s.maxItems!==undefined&&frame.count>s.maxItems))
      throw new BridgeError("response_schema_mismatch","Response array length is invalid");
    if(!frame.flushed&&frame.entries.every(e=>e.node.kind==="value")){
      const value=kind==="array"?frame.entries.map(e=>(e.node as any).value):Object.fromEntries(frame.entries.map(e=>[e.key,(e.node as any).value]));
      this.emit({kind:"value",value});return;
    }
    this.flush(frame);this.emit({kind,id:frame.id,count:frame.count});
  }
  private key(value:string){
    if(this.skipDepth){this.skipPreserveEmptyObject=false;return;}
    const target=this.capture?.frames.at(-1) ?? this.frames.at(-1);
    if(!target||target.kind!=="object"||target.keys.has(value))throw new BridgeError("invalid_json_response","Duplicate or misplaced response key");
    target.keys.add(value);target.key=value;
  }
  private scalar(value:any,ignored=false){
    if(this.skipDepth){this.skipPreserveEmptyObject=false;return;}
    if(this.capture){this.captureValue(value);return;}
    const location=this.place();
    if(ignored){this.emit({kind:"value",value:withheld()});return;}
    check(value,location.schema);assertSafeNumbers(value);
    this.emit({kind:"value",value:this.small(safeShape(value,location.schema,0,withheld),location.path)});
  }
  private token(t:Token){
    if(t.name==="startObject"||t.name==="startArray"){this.start(t.name==="startObject"?"object":"array");return;}
    if(t.name==="endObject"||t.name==="endArray"){this.end(t.name==="endObject"?"object":"array");return;}
    if(t.name==="startKey"||t.name==="startString"||t.name==="startNumber"){
      let ignore=this.skipDepth>0;
      if(t.name==="startString"&&!this.capture&&!ignore){const s=shape(this.place().schema);ignore=!s.type&&!s.enum&&!s.properties&&!s.items&&!s.oneOf&&!s.anyOf;}
      this.lex={kind:t.name==="startKey"?"key":t.name==="startString"?"string":"number",text:"",bytes:0,ignore};return;
    }
    if(t.name==="stringChunk"||t.name==="numberChunk"){
      const lex=this.lex!;if(lex.ignore)return;
      lex.bytes+=Buffer.byteLength(t.value);
      if(lex.bytes>(lex.kind==="key"?65536:lex.kind==="number"?1024:this.maxValueBytes))throw new BridgeError("json_value_limit","JSON scalar exceeds configured inspection limit");
      lex.text+=t.value;
      if(this.capture){this.capture.bytes+=Buffer.byteLength(t.value)+8;if(this.capture.bytes>this.maxValueBytes)throw new BridgeError("json_value_limit","Response union exceeds configured inspection limit");}
      return;
    }
    if(t.name==="endKey"||t.name==="endString"||t.name==="endNumber"){
      const lex=this.lex!;this.lex=undefined;
      if(t.name==="endKey"){this.key(lex.text);return;}
      this.scalar(lex.ignore?null:t.name==="endNumber"?Number(lex.text):lex.text,lex.ignore);return;
    }
    if(t.name==="nullValue"||t.name==="trueValue"||t.name==="falseValue"){this.scalar(t.value);return;}
    if(t.name!=="whitespace")throw new BridgeError("invalid_json_response","Unexpected JSON token");
  }
  async push(chunk:Uint8Array){
    if(this.error||this.ended)return;
    try{
      const text=this.decoder.decode(chunk,{stream:true});
      await new Promise<void>(resolve=>this.tokenizer.write(text,error=>{if(error)this.error ??= "invalid_json_response";resolve();}));
    }catch(error){this.fail(error);}
  }
  async finish():Promise<JsonProjectionMeta>{
    if(!this.ended){
      this.ended=true;
      if(!this.error)try{this.tokenizer.end(this.decoder.decode());}catch(error){this.fail(error);}
      await this.completion;
    }
    if(this.error||!this.root||this.frames.length||this.capture||this.skipDepth){
      this.tree.discard();throw new BridgeError(this.error ?? "invalid_json_response","JSON display unavailable; original retained");
    }
    return {kind:"json",tree_id:this.tree.id,root:this.root,complete:true};
  }
  discard(){this.tokenizer.destroy();this.tree.discard();}
}
