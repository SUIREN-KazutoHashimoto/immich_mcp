import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import original from "../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json" with {type:"json"};
import fingerprints from "./generated/integrity.json" with {type:"json"};
import { registry } from "./registry.js";
export const PINNED_OPENAPI_SHA256="632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export async function runtimeIntegrity(base:string|URL=import.meta.url):Promise<"ok"|"error">{
  try{
    if(fingerprints.format!==1||fingerprints.version!=="3.3.5"||fingerprints.source_sha256!==PINNED_OPENAPI_SHA256||
      registry.version!=="3.3.5"||registry.sha256!==PINNED_OPENAPI_SHA256||registry.operations.length!==279||
      hash(JSON.stringify(registry))!==fingerprints.registry_value_sha256)return "error";
    const triples=new Set<string>();
    for(const [path,item] of Object.entries<any>(original.paths))for(const [method,operation] of Object.entries<any>(item)){
      if(!["get","post","put","delete","patch","head","options","trace"].includes(method))continue;
      triples.add(JSON.stringify([operation.operationId,method.toUpperCase(),path]));
    }
    if(triples.size!==279||new Set(registry.operations.map(o=>o.operationId)).size!==279||
      registry.operations.some(o=>!triples.has(JSON.stringify([o.operationId,o.method,o.path]))))return "error";
    const files:[string,string][]=[
      ["./generated/registry.json",fingerprints.assets.registry],["./generated/upload-script.json",fingerprints.assets.upload_script],
      ["../immich_mcp_spec_v3.3.5/contracts/mcp-tool-contracts.json",fingerprints.assets.tools],
      ["../contracts/sync-records.v3.3.5.json",fingerprints.assets.sync],
      ["../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",PINNED_OPENAPI_SHA256]
    ];
    for(const [path,expected] of files){
      const url=new URL(path,base),info=await lstat(url);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)return "error";
      const digest=createHash("sha256");let bytes=0;
      for await(const chunk of createReadStream(url)){bytes+=chunk.length;if(bytes>16*1024*1024)return "error";digest.update(chunk);}
      if(digest.digest("hex")!==expected)return "error";
    }
    return "ok";
  }catch{return "error";}
}
