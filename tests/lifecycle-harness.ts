import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { discoveryBackend } from "./discovery-harness.js";

const oracle=JSON.parse(readFileSync(new URL("./profile-image-oracle.json",import.meta.url),"utf8")).entries;
const at="2026-11-10T00:00:00.000Z";
// Source-derived synthetic state model. It is not an Immich/container runtime.
export function lifecycleBackend(){
  const base=discoveryBackend(),{backend}=base;
  const model=Object.assign(base.model,{files:[] as any[],cleanupCalls:0,pendingDeletion:[] as string[],deletePolls:0,
    queues:Object.fromEntries(["duplicateDetection","backgroundTask","sidecar","metadataExtraction","thumbnailGeneration"].map(name=>[name,{name,isPaused:false}])),
    queuePauseNoEffect:false,queueResumeNoEffect:false,lostPauseReply:false,fileDeleteNoEffect:false,
    singletonNoEffect:false,mergeNoEffect:false,restoreNoEffect:false,emptyWrongOwner:false,missingDeletionJob:false,
    metadataNoEffect:false,rangeWrongBytes:false,badFileBytes:false,wrongOwnerFileBytes:false,trashEnabled:true});
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const tag=(t:any)=>({...sample(registry.schemas.TagResponseDto!),id:t.id,name:t.name,value:t.name,...(t.color?{color:t.color}:{})});
  const tags=(a:any)=>[...(a.tags??new Set())].map(id=>tag(model.tags.find(t=>t.id===id)));
  const patchAsset=(a:any,data:any)=>({...data,duplicateId:a.duplicateId??null,isTrashed:!!a.trashed,tags:tags(a)});
  const asset=(a:any,u:any)=>patchAsset(a,{...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),
    originalFileName:a.filename,originalPath:a.path,checksum:a.checksum,type:"IMAGE",visibility:a.visibility??"timeline",
    isFavorite:a.owner.id===u.id&&a.favorite,width:64,height:32,fileCreatedAt:a.date,fileModifiedAt:a.date,localDateTime:a.date,
    createdAt:at,updatedAt:at,exifInfo:a.exif});
  const visible=(a:any,u:any)=>a.owner.id===u.id||model.albums.some(x=>x.assets.has(a.id)&&x.viewers.some((v:any)=>v.user.id===u.id));
  const fileDto=(f:any)=>({id:f.id,createdAt:at,updatedAt:at,type:f.type,path:f.path,isEdited:f.isEdited,isProgressive:f.isProgressive,isTransparent:f.isTransparent});
  const ensureFiles=(a:any)=>{
    if(model.files.some(f=>f.assetId===a.id))return;
    const color=a.filename.includes("lifecycle_b")?2:0;
    for(const [type,format] of [["preview","jpeg"],["thumbnail","webp"]] as const){
      const image=oracle.find((p:any)=>p.id==="color_"+color+"_"+format)!;
      model.files.push({id:randomUUID(),assetId:a.id,type,path:"/synthetic/"+a.owner.id+"/"+a.id+"-"+type+"."+format,
        isEdited:false,isProgressive:format==="jpeg",isTransparent:false,bytes:Buffer.from(image.base64,"base64"),mime:image.mime});
    }
    if(a.sidecar)model.files.push({id:randomUUID(),assetId:a.id,type:"sidecar",path:"/synthetic/"+a.owner.id+"/"+a.id+".xmp",
      isEdited:false,isProgressive:false,isTransparent:false,bytes:a.sidecar,mime:"application/rdf+xml"});
  };
  const groupAssets=(id:string)=>model.assets.filter(a=>a.duplicateId===id&&!a.trashed&&!a.stackId&&["timeline","archive"].includes(a.visibility??"timeline"));
  const ownsGroup=(id:string,u:any)=>model.assets.some(a=>a.duplicateId===id&&a.owner.id===u.id&&!a.trashed);
  const group=(id:string,u:any)=>{
    const assets=groupAssets(id).filter(a=>a.owner.id===u.id).toSorted((a,b)=>a.date.localeCompare(b.date)).map(a=>asset(a,u));
    const best=assets.toSorted((a,b)=>(a.exifInfo.fileSizeInByte-b.exifInfo.fileSizeInByte)||
      (Object.values(a.exifInfo).filter(Boolean).length-Object.values(b.exifInfo).filter(Boolean).length)).at(-1);
    return {duplicateId:id,assets,suggestedKeepAssetIds:best?[best.id]:[]};
  };
  const removeDeleted=()=>{
    const removed=new Set(model.pendingDeletion);
    model.assets.splice(0,model.assets.length,...model.assets.filter(a=>!removed.has(a.id)));
    model.files.splice(0,model.files.length,...model.files.filter(f=>!removed.has(f.assetId)));
    for(const a of model.albums)for(const id of removed)a.assets.delete(id);
    model.pendingDeletion.length=0;
  };
  const queueDto=(name:string)=>{
    const q=model.queues[name];assert.ok(q,"known queue");
    let active=0;
    if(name==="backgroundTask"&&model.pendingDeletion.length){
      if(model.deletePolls>0){model.deletePolls--;active=1;}else removeDeleted();
    }
    return {name,isPaused:q.isPaused,statistics:{active,completed:0,failed:0,delayed:0,waiting:0,paused:0}};
  };
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    const direct=/^\/api\/(asset-files|duplicates|trash|queues)(\/|$)/.test(path)||path==="/api/system-config"||
      path==="/api/assets"&&["PUT","DELETE"].includes(method)||/^\/api\/admin\/users\/[^/]+\/statistics$/.test(path);
    if(!direct){
      const response=await base.http(input,init);
      if(response.status===201&&path==="/api/assets"&&method==="POST"){
        const value=await response.clone().json() as any,a=model.assets.find(a=>a.id===value.id);a.trashed=false;a.duplicateId=null;return response;
      }
      const match=/^\/api\/assets\/([^/]+)$/.exec(path);
      if(match&&response.status===200){
        const a=model.assets.find(a=>a.id===match[1]),data=await response.json() as any;
        if(model.metadataNoEffect&&method==="PUT"&&init.body){const body=JSON.parse(String(init.body));if(Object.hasOwn(body,"description"))a.exif.description=null;}
        const key=backend.keys.find(k=>k.secret===headers.get("x-api-key"));return Response.json(patchAsset(a,{...data,exifInfo:a.exif}),{status:200});
      }
      if(path==="/api/search/metadata"&&response.status===200){
        const data=await response.json() as any,key=backend.keys.find(k=>k.secret===headers.get("x-api-key"))!;
        const rows=data.assets.items.filter((x:any)=>{const a=model.assets.find(a=>a.id===x.id);return a&&!a.trashed;})
          .map((x:any)=>patchAsset(model.assets.find(a=>a.id===x.id),x));
        data.assets.items=rows;data.assets.total=rows.length;if(Object.hasOwn(data.assets,"count"))data.assets.count=rows.length;
        return Response.json(data);
      }
      return response;
    }
    assert.equal(url.origin,"http://127.0.0.1:22835");
    for(const name of ["authorization","cookie","cf-access-jwt-assertion"])assert.equal(headers.get(name),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),u=key?.owner,body=init.body?JSON.parse(String(init.body)):undefined;
    backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(value:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,value)??value,{status});
    const denied=()=>finish({message:"not found or no access"},400);
    if(!key||!u)return finish({message:"missing caller"},401);
    if(!key.permissions.includes("all"))return finish({message:"scope refused"},403);
    if(path.startsWith("/api/queues/")){
      if(!u.isAdmin)return finish({message:"administrator required"},403);
      const name=path.split("/")[3]!,q=model.queues[name];assert.ok(q,"known queue route");
      if(method==="PUT"){
        if(body.isPaused&&!model.queuePauseNoEffect||body.isPaused===false&&!model.queueResumeNoEffect)q.isPaused=body.isPaused;
        if(model.lostPauseReply&&body.isPaused)throw Error("simulated lost pause acknowledgement after effect");
        return finish({...queueDto(name),isPaused:body.isPaused});
      }return finish(queueDto(name));
    }
    if(path==="/api/system-config"){
      if(!u.isAdmin)return finish({message:"administrator required"},403);
      const data=sample(registry.schemas.AdminConfigDto!) as any;data.trash={enabled:model.trashEnabled,days:30};return finish(data);
    }
    if(path.startsWith("/api/admin/users/")){
      if(!u.isAdmin)return finish({message:"administrator required"},403);
      const owner=path.split("/")[4],visibility=url.searchParams.get("visibility"),trashed=url.searchParams.get("isTrashed")==="true";
      const all=model.assets.filter(a=>a.owner.id===owner&&(a.visibility??"timeline")===visibility&&!!a.trashed===trashed&&(!trashed||a.status!=="deleted"));
      return finish({images:all.length,videos:0,total:all.length});
    }
    if(path==="/api/assets"){
      const assets=body.ids.map((id:string)=>model.assets.find(a=>a.id===id));
      if(assets.some((a:any)=>!a||a.owner.id!==u.id))return denied();
      if(method==="PUT")for(const a of assets){if(Object.hasOwn(body,"duplicateId"))a.duplicateId=body.duplicateId;}
      else for(const a of assets){a.trashed=true;a.status=body.force?"deleted":"trashed";}
      return finish(undefined,204);
    }
    if(path.startsWith("/api/asset-files")){
      if(path==="/api/asset-files"){
        const a=model.assets.find(a=>a.id===url.searchParams.get("assetId"));if(!a||!visible(a,u))return denied();ensureFiles(a);
        return finish(model.files.filter(f=>f.assetId===a.id&&["type","isEdited","isProgressive","isTransparent"].every(k=>!url.searchParams.has(k)||
          (k==="type"?f[k]===url.searchParams.get(k):f[k]===(url.searchParams.get(k)==="true")))).map(fileDto));
      }
      const id=path.split("/")[3],file=model.files.find(f=>f.id===id),a=file&&model.assets.find(a=>a.id===file.assetId);
      if(!file||a?.owner.id!==u.id||(a.visibility??"timeline")==="locked")return denied();
      if(method==="DELETE"){
        if(file.type==="sidecar")return denied();
        if(!model.fileDeleteNoEffect)model.files.splice(model.files.indexOf(file),1);return finish(undefined,204);
      }
      if(path.endsWith("/download")){
        const fallback=oracle.find((p:any)=>p.id==="color_0_jpeg")!;
        const bytes=model.badFileBytes?Buffer.from("bad image"):model.wrongOwnerFileBytes&&a.filename.includes("lifecycle_b")?Buffer.from(fallback.base64,"base64"):file.bytes;
        const responseHeaders={"content-type":file.mime,"accept-ranges":"bytes"},range=headers.get("range");
        if(range){
          const match=/^bytes=(\d+)-(\d*)$/.exec(range);assert.ok(match,"bounded synthetic Range");
          const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
          if(start>=bytes.length||end<start)return finish({message:"synthetic fixed-helper unsatisfiable range"},404);
          const part=Buffer.from(bytes.subarray(start,end+1));if(model.rangeWrongBytes&&part.length)part[0]=part[0]!^1;
          return new Response(new Uint8Array(part),{status:206,headers:{...responseHeaders,
            "content-range":"bytes "+start+"-"+end+"/"+bytes.length,"content-length":String(part.length)}});
        }
        return new Response(new Uint8Array(bytes),{headers:{...responseHeaders,"content-length":String(bytes.length)}});
      }return finish(fileDto(file));
    }

    if(path.startsWith("/api/duplicates")){
      if(path==="/api/duplicates"&&method==="GET"){
        model.cleanupCalls++;
        const counts=new Map<string,number>();
        for(const a of model.assets.filter(a=>a.owner.id===u.id&&a.duplicateId&&!a.trashed&&!a.stackId))
          counts.set(a.duplicateId,(counts.get(a.duplicateId)??0)+1);
        for(const [id,n] of counts)if(n===1&&!model.singletonNoEffect)
          for(const a of model.assets.filter(a=>a.duplicateId===id))a.duplicateId=null;
        const ids=[...new Set(model.assets.filter(a=>a.owner.id===u.id&&a.duplicateId).map(a=>a.duplicateId))];
        return finish(ids.map(id=>group(id,u)).filter(g=>g.assets.length>1));
      }
      if(method==="DELETE"){
        const ids=path==="/api/duplicates"?body.ids:[path.split("/")[3]];
        if(ids.some((id:string)=>!ownsGroup(id,u)))return denied();
        for(const a of model.assets.filter(a=>a.owner.id===u.id&&ids.includes(a.duplicateId)))a.duplicateId=null;
        return finish(undefined,204);
      }
      assert.equal(path,"/api/duplicates/resolve");
      if(body.groups.some((g:any)=>!ownsGroup(g.duplicateId,u)))return denied();
      const results=[];
      for(const g of body.groups){
        // The repository get(groupId) has no extra owner predicate. Normal
        // fixtures use disjoint freshly generated IDs for each owner.
        const assets=groupAssets(g.duplicateId).toSorted((a,b)=>a.date.localeCompare(b.date)),all=new Set(assets.map(a=>a.id)),
          keep=g.keepAssetIds.filter((id:string)=>all.has(id)),trash=g.trashAssetIds.filter((id:string)=>all.has(id));
        if(assets.some(a=>keep.includes(a.id)&&trash.includes(a.id)||!keep.includes(a.id)&&!trash.includes(a.id))){
          results.push({id:g.duplicateId,success:false,error:"validation"});continue;
        }
        if(trash.some((id:string)=>model.assets.find(a=>a.id===id)?.owner.id!==u.id)){
          results.push({id:g.duplicateId,success:false,error:"no_permission"});continue;
        }
        if(keep.length===1&&trash.length){
          const target=model.assets.find(a=>a.id===keep[0])!,lines:string[]=[],tagIds=new Set<string>();
          for(const a of assets){
            for(const line of String(a.exif.description??"").split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean))if(!lines.includes(line))lines.push(line);
            for(const tagId of a.tags)tagIds.add(tagId);
          }
          if(!model.mergeNoEffect)target.favorite=assets.some(a=>a.favorite);
          target.visibility=["locked","archive","timeline","hidden"].find(level=>assets.some(a=>a.visibility===level))??"timeline";
          target.exif.rating=Math.max(...assets.map(a=>a.exif.rating??0));target.exif.description=lines.length?lines.join("\n"):target.exif.description;
          target.tags=tagIds;
          for(const album of model.albums.filter(a=>a.owner.id===u.id&&assets.some(x=>a.assets.has(x.id))))album.assets.add(target.id);
        }
        for(const a of assets){
          if(keep.includes(a.id))a.duplicateId=null;
          if(trash.includes(a.id)){a.duplicateId=null;a.trashed=true;a.status=model.trashEnabled?"trashed":"deleted";}
        }
        results.push({id:g.duplicateId,success:true});
      }return finish(results);
    }
    if(path.startsWith("/api/trash/")){
      if(path==="/api/trash/restore/assets"){
        const assets=body.ids.map((id:string)=>model.assets.find(a=>a.id===id));
        if(assets.some((a:any)=>!a||a.owner.id!==u.id))return denied();
        if(!model.restoreNoEffect)for(const a of assets)if(a.status==="trashed"){a.status="active";a.trashed=false;}
        return finish({count:body.ids.length});
      }
      if(path==="/api/trash/restore"){
        const assets=model.assets.filter(a=>a.owner.id===u.id&&a.status==="trashed");
        if(!model.restoreNoEffect)for(const a of assets){a.status="active";a.trashed=false;}
        return finish({count:assets.length});
      }
      assert.equal(path,"/api/trash/empty");
      const assets=model.assets.filter(a=>a.owner.id===u.id&&a.status==="trashed"),
        targets=model.emptyWrongOwner?model.assets.filter(a=>a.owner.id!==u.id&&a.status==="trashed"):assets;
      for(const a of targets)a.status="deleted";
      if(!model.missingDeletionJob){model.pendingDeletion.push(...targets.map(a=>a.id));model.deletePolls=1;}
      return finish({count:assets.length});
    }
    throw Error("Unexpected lifecycle fixture route");
  }) as typeof fetch;
  return {backend,model,http};
}
