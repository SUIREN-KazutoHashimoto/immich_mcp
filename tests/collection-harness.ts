import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { mediaBackend } from "./media-harness.js";

// This model follows fixed service/repository semantics; it is not an Immich runtime.
export function collectionBackend(){
  const base=mediaBackend(),{backend}=base;
  const model={...base.model,memories:[] as any[],stacks:[] as any[],
    memoryAddNoEffect:false,omitMergeChild:false,partialBulkDelete:false,leakSearch:false,primaryNoEffect:false,loseMerge:false};
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const asset=(a:any,withStack=false)=>{
    const s=model.stacks.find(s=>s.id===a.stackId);
    return {...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),originalFileName:a.filename,checksum:a.checksum,
      type:"IMAGE",visibility:"timeline",isFavorite:false,tags:[],exifInfo:{...sample(registry.schemas.ExifResponseDto!),exifImageWidth:64,exifImageHeight:32},
      stack:withStack?(s?{id:s.id,primaryAssetId:s.primary,assetCount:model.assets.filter(a=>a.stackId===s.id).length}:null):undefined};
  };
  const memory=(m:any)=>({...sample(registry.schemas.MemoryResponseDto!),id:m.id,ownerId:m.owner.id,type:m.type,data:m.data,memoryAt:m.memoryAt,
    isSaved:m.isSaved,createdAt:"2026-01-02T03:04:05.000Z",updatedAt:"2026-01-02T03:04:05.000Z",
    ...(m.seenAt?{seenAt:m.seenAt}:{}),...(m.showAt?{showAt:m.showAt}:{}),...(m.hideAt?{hideAt:m.hideAt}:{}),
    assets:[...m.assets].map(id=>asset(model.assets.find(a=>a.id===id)))});
  const stack=(s:any)=>{
    const items=model.assets.filter(a=>a.stackId===s.id),primary=items.filter(a=>a.id===s.primary),others=items.filter(a=>a.id!==s.primary);
    return {id:s.id,primaryAssetId:s.primary,assets:[...primary,...others].map(a=>asset(a))};
  };
  const erase=(s:any)=>{model.stacks.splice(model.stacks.indexOf(s),1);for(const a of model.assets)if(a.stackId===s.id)a.stackId=null;};
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(method==="GET"&&/^\/api\/assets\/[^/]+$/.test(path)){
      const response=await base.http(input,init);if(response.status!==200)return response;
      const a=model.assets.find(a=>a.id===path.split("/").at(-1));assert.ok(a);return Response.json(asset(a,true));
    }
    if(!path.startsWith("/api/memories")&&!path.startsWith("/api/stacks"))return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");
    assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner;
    const body=init.body?JSON.parse(String(init.body)):undefined,record={path,method,headers,body};backend.calls.push(record);await backend.before?.(path,body);
    const finish=(data:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,data)??data,{status});
    const denied=()=>finish({message:"not found or no access"},400);
    if(!user||!key)return finish({message:"missing caller"},401);
    if(!key.permissions.includes("all"))return finish({message:"permission refused"},403);
    if(path==="/api/memories"&&method==="POST"){
      const allowed=(body.assetIds??[]).filter((id:string)=>model.assets.some(a=>a.id===id&&a.owner.id===user.id));
      const m={...body,id:randomUUID(),owner:user,isSaved:body.isSaved??false,assets:new Set(allowed)};model.memories.push(m);return finish(memory(m),201);
    }
    if((path==="/api/memories"||path==="/api/memories/statistics")&&method==="GET"){
      const q=url.searchParams;
      let found=model.memories.filter(m=>m.owner.id===user.id&&(!q.has("isSaved")||String(m.isSaved)===q.get("isSaved"))&&
        (!q.has("type")||m.type===q.get("type"))&&q.get("isTrashed")!=="true"&&
        (!q.has("for")||(!m.showAt||m.showAt<=q.get("for")+"T00:00:00.000Z")&&(!m.hideAt||m.hideAt>=q.get("for")+"T00:00:00.000Z")));
      if(path.endsWith("/statistics"))return finish({total:found.length});
      if(q.has("id"))found=found.filter(m=>m.id===q.get("id"));
      if(q.has("size")){const size=Number(q.get("size")),page=Number(q.get("page")??1);found=found.slice((page-1)*size,page*size);}
      found=found.filter(m=>m.assets.size>0);
      if(model.leakSearch&&q.has("id")&&found.length){const other=model.memories.find(m=>m.owner.id!==user.id);if(other)found=[...found,other];}
      return finish(found.map(memory));
    }
    const mm=/^\/api\/memories\/([^/]+)(\/assets)?$/.exec(path);
    if(mm){
      const m=model.memories.find(m=>m.id===mm[1]);if(!m||m.owner.id!==user.id)return denied();
      if(!mm[2]){
        if(method==="GET")return finish(memory(m));
        if(method==="PUT"){for(const [key,value] of Object.entries(body))m[key]=value;return finish(memory(m));}
        if(method==="DELETE"){model.memories.splice(model.memories.indexOf(m),1);return finish(null,204);}
      }else{
        const results=body.ids.map((id:string)=>{
          if(method==="PUT"){
            if(m.assets.has(id))return {id,success:false,error:"duplicate"};
            if(!model.assets.some(a=>a.id===id&&a.owner.id===user.id))return {id,success:false,error:"no_permission"};
            if(!model.memoryAddNoEffect)m.assets.add(id);return {id,success:true};
          }
          if(!m.assets.has(id))return {id,success:false,error:"not_found"};
          m.assets.delete(id);return {id,success:true};
        });return finish(results);
      }
    }
    if(path==="/api/stacks"){
      if(method==="GET")return finish(model.stacks.filter(s=>s.owner.id===user.id&&(!url.searchParams.has("primaryAssetId")||s.primary===url.searchParams.get("primaryAssetId"))).map(stack));
      if(method==="POST"){
        if(body.assetIds.some((id:string)=>!model.assets.some(a=>a.id===id&&a.owner.id===user.id)))return denied();
        const old=model.stacks.filter(s=>s.owner.id===user.id&&body.assetIds.includes(s.primary)),include=new Set<string>(body.assetIds);
        for(const s of old){
          const children=model.assets.filter(a=>a.stackId===s.id);
          for(const a of model.omitMergeChild?children.filter(a=>a.id===s.primary):children)include.add(a.id);
        }
        for(const s of old)erase(s);
        const s={id:randomUUID(),owner:user,primary:body.assetIds[0]};model.stacks.push(s);
        for(const a of model.assets)if(include.has(a.id))a.stackId=s.id;
        if(model.loseMerge&&old.length)throw Error("response lost after stack merge commit");
        return finish(stack(s),201);
      }
      if(method==="DELETE"){
        const selected=body.ids.map((id:string)=>model.stacks.find(s=>s.id===id));
        if(selected.some((s:any)=>!s||s.owner.id!==user.id))return denied();
        for(const s of model.partialBulkDelete?selected.slice(0,1):selected)erase(s);
        return finish(null,204);
      }
    }
    const sm=/^\/api\/stacks\/([^/]+)(?:\/assets\/([^/]+))?$/.exec(path);
    if(sm){
      const s=model.stacks.find(s=>s.id===sm[1]);if(!s||s.owner.id!==user.id)return denied();
      if(sm[2]){
        const a=model.assets.find(a=>a.id===sm[2]);if(!a||a.stackId!==s.id||s.primary===a.id)return denied();
        a.stackId=null;return finish(null,204);
      }
      if(method==="GET")return finish(stack(s));
      if(method==="PUT"){
        if(body.primaryAssetId&&!model.assets.some(a=>a.id===body.primaryAssetId&&a.stackId===s.id))return denied();
        if(body.primaryAssetId&&!model.primaryNoEffect)s.primary=body.primaryAssetId;
        return finish(stack(s));
      }
      if(method==="DELETE"){erase(s);return finish(null,204);}
    }
    throw Error("Unexpected collection harness route "+method+" "+path);
  }) as typeof fetch;
  return {backend,model,http};
}
