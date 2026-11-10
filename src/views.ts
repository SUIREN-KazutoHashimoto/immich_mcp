import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { Control } from "./control.js";
import { pointer } from "./projection.js";
import { registry } from "./registry.js";
import { ResultPages,type PagedProjection } from "./result-pages.js";
import { BridgeError } from "./types.js";
import { JsonTree,type JsonProjectionMeta } from "./json-tree.js";
export class Views {
  constructor(readonly vault:Vault,readonly control:Control,readonly maxBytes=128*1024,readonly ttlMs=3600_000) {}
  store(principal:string,data:any) {return this.vault.put(principal,"view",{display:data},Date.now()+this.ttlMs,"view_"+randomUUID());}
  read(principal:string,input:{result_ref:string;json_pointer?:string;cursor?:string;offset?:number;limit?:number;mode?:string}) {
    const ref=input.result_ref,path=input.json_pointer ?? "",mode=input.mode ?? "json";
    if(!["json","jsonl","text","metadata","preview"].includes(mode))throw new BridgeError("invalid_mode","Unknown result view mode");
    let data=ref.startsWith("view_")?this.vault.get(principal,ref,"view").display:this.control.readResult(principal,ref);
    const stored=ref.startsWith("view_")?undefined:this.vault.get(principal,ref,"result");
    const sourceIncomplete=stored?.display.state==="failed"||stored?.display.state==="outcome_unknown";
    const projection=stored?.projection as PagedProjection|JsonProjectionMeta|undefined;
    const limit=input.limit ?? 50;
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new BridgeError("invalid_limit","Read limit must be 1 to 1000");
    let offset=input.offset ?? 0;
    if(input.cursor){
      if(input.offset!==undefined)throw new BridgeError("invalid_cursor","Do not combine offset and cursor");
      try{
        const c=JSON.parse(Buffer.from(input.cursor,"base64url").toString());
        if(c.ref!==ref||c.path!==path||c.mode!==mode||c.sha!==registry.sha256)throw Error();
        offset=c.offset;
      }catch{throw new BridgeError("invalid_cursor","Cursor does not match this result view");}
    }
    if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError("invalid_cursor","Invalid result offset");
    let paged=false,total=1;
    if(mode==="metadata"){
      data=stored?{upstream:stored.display.upstream,size_bytes:stored.raw.size,sha256:stored.raw.sha256,
        transfer_complete:this.vault.get(principal,stored.raw.raw_ref,"raw").transfer_complete ?? true,
        ...(projection?.kind==="jsonl"?{stream:{kind:projection.kind,total_records:projection.total_records,complete:projection.complete,terminal:projection.terminal,error:projection.error}}:projection?.kind==="json"?{json:{kind:"json",complete:true,root_type:projection.root.kind}}:{})}:
        {kind:"schema_view",source_sha256:registry.sha256};
      data=pointer(data,path);
    }else if(projection?.kind==="json"&&(path==="/data"||path.startsWith("/data/")||mode==="jsonl")){
      const tree=new JsonTree(this.vault,principal,undefined,projection.tree_id),node=tree.locate(projection.root,mode==="jsonl"?path:path.slice(5));
      if(mode==="text")data=tree.value(node,this.maxBytes);
      else {const selected=tree.page(node,offset,limit,this.maxBytes);data=selected.data;total=selected.total;paged=true;}
    }else if(projection?.kind==="jsonl"&&(mode==="jsonl"||(["json","preview"].includes(mode)&&(path==="/data"||path.startsWith("/data/"))))){
      const localPath=mode==="jsonl"?path:path.slice(5),pages=new ResultPages(this.vault,principal,undefined,projection.stream_id);
      if(localPath===""){
        total=projection.total_records;data=pages.read(offset,limit);paged=true;
        if(data.length!==Math.max(0,Math.min(limit,total-offset)))throw new BridgeError("invalid_reference","Result pages are unavailable");
      }else{
        const match=/^\/(0|[1-9][0-9]*)(\/.*)?$/.exec(localPath),index=Number(match?.[1]);
        if(!match||!Number.isSafeInteger(index)||index>=projection.total_records)throw new BridgeError("invalid_pointer","Pointer unavailable");
        const record=pages.read(index,1);if(record.length!==1)throw new BridgeError("invalid_reference","Result page is unavailable");
        data=pointer(record[0],match[2] ?? "");
      }
    }else data=pointer(data,path);
    if(mode==="text")data=typeof data==="string"?data:JSON.stringify(data);
    let page:any=data;
    if(!paged){
      if(Array.isArray(data)){total=data.length;page=data.slice(offset,offset+limit);}
      else if(data&&typeof data==="object"){const entries=Object.entries(data);total=entries.length;page=Object.fromEntries(entries.slice(offset,offset+limit));}
      else if(typeof data==="string"){const characters=Array.from(data);total=characters.length;page=characters.slice(offset,offset+limit).join("");}
      else if(offset>0)page=null;
    }
    if(Buffer.byteLength(JSON.stringify(page))>this.maxBytes)throw new BridgeError("result_page_too_large","Use a narrower JSON Pointer or a smaller read limit");
    const exhausted=offset+limit>=total;
    return {result_ref:ref,data:page,next_cursor:exhausted?null:Buffer.from(JSON.stringify({ref,path,mode,sha:registry.sha256,offset:offset+limit})).toString("base64url"),
      complete:exhausted&&!sourceIncomplete&&(!projection||projection.complete),truncated:false,
      diagnostic:projection?.kind==="jsonl"&&projection.error?{code:projection.error,message:"Sync stream is incomplete; only retained display records are available",source:"mcp_bridge"}:stored?.display.diagnostic?{...stored.display.diagnostic,source:stored.display.diagnostic.source ?? "mcp_bridge"}:null};
  }
}
