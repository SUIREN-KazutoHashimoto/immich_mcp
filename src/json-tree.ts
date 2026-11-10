import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import { BridgeError } from "./types.js";
import { pointer } from "./projection.js";
export type JsonNode={kind:"value";value:any}|{kind:"array"|"object";id:string;count:number};
export interface JsonProjectionMeta {kind:"json";tree_id:string;root:JsonNode;complete:true;}
export interface JsonEntry {key:string;node:JsonNode;}
export class JsonTree {
  readonly id:string;
  constructor(readonly vault:Vault,readonly principal:string,readonly expires=Date.now()+3600_000,id?:string){
    this.id=id ?? "json_"+randomUUID();
    vault.db.exec("CREATE TABLE IF NOT EXISTS json_pages(principal TEXT NOT NULL,tree TEXT NOT NULL,node TEXT NOT NULL,start INTEGER NOT NULL,count INTEGER NOT NULL,ref TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,tree,node,start))");
  }
  write(node:string,start:number,entries:JsonEntry[]){
    this.vault.db.exec("SAVEPOINT json_page");
    try{
      const ref=this.vault.put(this.principal,"json_page",{entries},this.expires);
      this.vault.db.prepare("INSERT INTO json_pages VALUES(?,?,?,?,?,?,?)").run(this.principal,this.id,node,start,entries.length,ref,this.expires);
      this.vault.db.exec("RELEASE json_page");
    }catch(error){this.vault.db.exec("ROLLBACK TO json_page; RELEASE json_page");throw error;}
  }
  entries(node:Extract<JsonNode,{id:string}>,offset:number,limit:number){
    const rows=this.vault.db.prepare("SELECT start,count,ref FROM json_pages WHERE principal=? AND tree=? AND node=? AND start<? AND start+count>? AND expires>=? ORDER BY start")
      .all(this.principal,this.id,node.id,offset+limit,offset,Date.now()) as {start:number;count:number;ref:string}[];
    const entries:JsonEntry[]=[];
    for(const row of rows){
      const data=this.vault.get(this.principal,row.ref,"json_page").entries;
      if(!Array.isArray(data)||data.length!==row.count)throw new BridgeError("invalid_reference","JSON result page unavailable");
      entries.push(...data.slice(Math.max(0,offset-row.start),Math.min(row.count,offset+limit-row.start)));
    }
    if(entries.length!==Math.max(0,Math.min(limit,node.count-offset)))throw new BridgeError("invalid_reference","JSON result page unavailable");
    return entries;
  }
  private materialize(node:JsonNode,budget:{remaining:number},depth=0):any{
    if(depth>100)throw new BridgeError("result_page_too_large","Use a narrower JSON Pointer");
    if(node.kind==="value"){
      budget.remaining-=Buffer.byteLength(JSON.stringify(node.value));
      if(budget.remaining<0)throw new BridgeError("result_page_too_large","Use a narrower JSON Pointer or smaller read limit");
      return structuredClone(node.value);
    }
    budget.remaining-=2;
    const output:any=node.kind==="array"?[]:{};
    for(let offset=0;offset<node.count;offset+=64)for(const entry of this.entries(node,offset,Math.min(64,node.count-offset))){
      budget.remaining-=Buffer.byteLength(JSON.stringify(entry.key))+2;
      if(budget.remaining<0)throw new BridgeError("result_page_too_large","Use a narrower JSON Pointer or smaller read limit");
      const value=this.materialize(entry.node,budget,depth+1);
      if(node.kind==="array")output.push(value);else Object.defineProperty(output,entry.key,{value,enumerable:true,writable:true,configurable:true});
    }
    return output;
  }
  value(node:JsonNode,maxBytes:number){return this.materialize(node,{remaining:maxBytes});}
  locate(root:JsonNode,path:string):JsonNode{
    if(!path)return root;
    if(!path.startsWith("/")||/~(?![01])/u.test(path))throw new BridgeError("invalid_pointer","Invalid JSON Pointer");
    const tokens=path.slice(1).split("/").map(t=>t.replace(/~1/g,"/").replace(/~0/g,"~"));
    let node=root;
    for(let i=0;i<tokens.length;i++){
      const key=tokens[i]!;
      if(node.kind==="value")return {kind:"value",value:pointer(node.value,"/"+tokens.slice(i).map(t=>t.replace(/~/g,"~0").replace(/\//g,"~1")).join("/"))};
      if(node.kind==="array"){
        if(!/^(0|[1-9][0-9]*)$/.test(key)||!Number.isSafeInteger(Number(key))||Number(key)>=node.count)throw new BridgeError("invalid_pointer","Pointer unavailable");
        node=this.entries(node,Number(key),1)[0]!.node;
      }else{
        let found:JsonNode|undefined;
        for(let offset=0;offset<node.count&&!found;offset+=64)found=this.entries(node,offset,Math.min(64,node.count-offset)).find(e=>e.key===key)?.node;
        if(!found)throw new BridgeError("invalid_pointer","Pointer unavailable");node=found;
      }
    }
    return node;
  }
  page(node:JsonNode,offset:number,limit:number,maxBytes:number){
    const budget={remaining:maxBytes};
    if(node.kind==="value"){
      const value=node.value;
      if(Array.isArray(value))return {data:value.slice(offset,offset+limit),total:value.length};
      if(value&&typeof value==="object")return {data:Object.fromEntries(Object.entries(value).slice(offset,offset+limit)),total:Object.keys(value).length};
      if(typeof value==="string"){const points=Array.from(value);return {data:points.slice(offset,offset+limit).join(""),total:points.length};}
      return {data:offset===0?value:null,total:1};
    }
    const entries=this.entries(node,offset,limit);
    const values=entries.map(e=>[e.key,this.materialize(e.node,budget)] as const);
    return {data:node.kind==="array"?values.map(e=>e[1]):Object.fromEntries(values),total:node.count};
  }
  discard(){
    this.vault.db.exec("SAVEPOINT json_discard");
    try{
      this.vault.db.prepare("DELETE FROM records WHERE principal=? AND kind='json_page' AND id IN (SELECT ref FROM json_pages WHERE principal=? AND tree=?)").run(this.principal,this.principal,this.id);
      this.vault.db.prepare("DELETE FROM json_pages WHERE principal=? AND tree=?").run(this.principal,this.id);
      this.vault.db.exec("RELEASE json_discard");
    }catch(error){this.vault.db.exec("ROLLBACK TO json_discard; RELEASE json_discard");throw error;}
  }
}
