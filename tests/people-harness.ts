import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { discoveryBackend } from "./discovery-harness.js";

const oracle=JSON.parse(readFileSync(new URL("./people-thumbnail-oracle.json",import.meta.url),"utf8")).variants;
// Independent source-derived HTTP state model; it does not run Immich/ML.
export function peopleBackend(){
  const base=discoveryBackend(),{backend}=base;
  const model=Object.assign(base.model,{people:[] as any[],faces:[] as any[],shares:[] as any[],requests:[] as any[],
    lostFaceReply:false,dropInvitation:false,joinNoEffect:false,shareWrongRole:false,reassignNoEffect:false,
    legacyMergeNoEffect:false,leaveNoRemap:false,badThumbnail:false,forceThumbnailHash:false});
  const initialize=()=>{for(const u of backend.users)(u as any).clusterGroupId??=randomUUID();};
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const visible=(a:any,u:any)=>a.owner.id===u.id||model.albums.some(x=>x.assets.has(a.id)&&x.viewers.some((v:any)=>v.user.id===u.id));
  const live=(f:any)=>!f.deleted;
  const groupPeople=(id:string)=>model.people.filter(p=>p.id===id);
  const person=(id:string,u:any)=>model.people.find(p=>p.id===id&&p.owner.id===u.id);
  const edges=(id:string,u:any)=>model.shares.filter(e=>e.personId===id&&(e.from.id===u.id||e.to.id===u.id));
  const dto=(p:any)=>({id:p.id,name:p.name,birthDate:p.birthDate,isHidden:p.isHidden,isFavorite:p.isFavorite,
    ...(p.color?{color:p.color}:{}),thumbnailPath:p.feature?"/synthetic/"+p.id+"/"+p.owner.id+".jpeg":"",
    otherPeople:[],sharedBy:model.shares.filter(e=>e.personId===p.id&&e.to.id===p.owner.id).map(e=>({...publicUser(e.from),role:e.role})),
    sharedWith:model.shares.filter(e=>e.personId===p.id&&e.from.id===p.owner.id).map(e=>({...publicUser(e.to),role:e.role}))});
  const create=(id:string,u:any,body:any)=>{
    const p={id,owner:u,name:body.name??"",birthDate:body.birthDate??null,isHidden:body.isHidden??false,
      isFavorite:body.isFavorite??false,color:body.color??null,feature:null as string|null};model.people.push(p);return p;
  };
  const assetDto=(a:any,u:any)=>({...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,
    owner:publicUser(a.owner),originalFileName:a.filename,checksum:a.checksum,type:"IMAGE",visibility:a.visibility??"timeline",
    isFavorite:a.owner.id===u.id&&a.favorite,width:64,height:32,
    exifInfo:{...sample(registry.schemas.ExifResponseDto!),exifImageWidth:64,exifImageHeight:32,fileSizeInByte:a.bytes.length}});
  const faceDto=(f:any,u:any)=>({id:f.id,boundingBoxX1:f.x,boundingBoxX2:f.x+f.width,boundingBoxY1:f.y,boundingBoxY2:f.y+f.height,
    imageWidth:64,imageHeight:32,sourceType:"manual",person:person(f.personId,u)?dto(person(f.personId,u)):null});
  const userHas=(id:string,u:any,target:any,roles:string[])=>!!person(id,target)&&(target.id===u.id||
    model.shares.some(e=>e.personId===id&&e.from.id===target.id&&e.to.id===u.id&&roles.includes(e.role)));
  const update=(id:string,u:any,body:any)=>{
    const target=body.userId?backend.users.find(x=>x.id===body.userId):u,p=target&&person(id,target);
    if(!p||!userHas(id,u,target,["write","admin"])||target.id!==u.id&&["isHidden","isFavorite","color","featureFaceAssetId"].some(k=>Object.hasOwn(body,k)))return undefined;
    if(body.featureFaceAssetId){
      const a=model.assets.find(a=>a.id===body.featureFaceAssetId),f=model.faces.find(f=>f.personId===id&&f.assetId===a?.id&&live(f));
      if(!a||!f||!visible(a,u))return undefined;
      if(!model.forceThumbnailHash)p.feature=f.id;
    }
    for(const k of ["name","birthDate","isHidden","isFavorite","color"])if(Object.hasOwn(body,k))p[k]=body[k];
    if(!body.userId)for(const edge of model.shares.filter(e=>e.personId===id&&e.to.id===u.id&&["write","admin"].includes(e.role))){
      const other=person(id,edge.from);if(other)for(const k of ["name","birthDate"])if(Object.hasOwn(body,k))other[k]=body[k];
    }
    return p;
  };
  const remove=(ids:string[],target:any)=>{
    model.people.splice(0,model.people.length,...model.people.filter(p=>p.owner.id!==target.id||!ids.includes(p.id)));
    model.shares.splice(0,model.shares.length,...model.shares.filter(e=>!ids.includes(e.personId)||e.from.id!==target.id&&e.to.id!==target.id));
  };
  const accessibleFaces=(id:string,u:any)=>model.faces.filter(f=>f.personId===id&&live(f)&&visible(model.assets.find(a=>a.id===f.assetId),u));
  const recordRequest=(r:any)=>({id:r.id,clusterGroupId:r.clusterGroupId,userId:r.userId,createdAt:r.createdAt});
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    const handled=/^\/api\/(people|faces|cluster-groups)(\/|$)/.test(path)||path==="/api/search/person"||
      path==="/api/users/me"||/^\/api\/admin\/users\/[^/]+\/statistics$/.test(path)||/^\/api\/assets\/[^/]+$/.test(path)&&method==="GET";
    if(!handled)return base.http(input,init);
    initialize();assert.equal(url.origin,"http://127.0.0.1:22835");
    for(const h of ["authorization","cookie","cf-access-jwt-assertion"])assert.equal(headers.get(h),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),u=key?.owner as any;
    const body=init.body?JSON.parse(String(init.body)):undefined,record={path,method,headers,body};backend.calls.push(record);await backend.before?.(path,body);
    const finish=(data:any,status=200)=>[201,204].includes(status)&&data===undefined||status===200&&data===undefined?new Response(null,{status}):
      Response.json(backend.after?.(path,data)??data,{status});
    const denied=()=>finish({message:"not found or no access"},400);
    if(!key||!u)return finish({message:"missing caller"},401);
    const assetMatch=/^\/api\/assets\/([^/]+)$/.exec(path);
    if(!key.permissions.includes("all")&&!(assetMatch&&key.permissions.includes("asset.read")))return finish({message:"permission refused"},403);
    if(path==="/api/users/me")return finish({...sample(registry.schemas.UserAdminResponseDto!),...publicUser(u),isAdmin:u.isAdmin,clusterGroupId:u.clusterGroupId});
    if(path.startsWith("/api/admin/users/")){
      if(!u.isAdmin)return finish({message:"administrator required"},403);
      const id=path.split("/")[4],all=model.assets.filter(a=>a.owner.id===id&&(a.visibility??"timeline")===url.searchParams.get("visibility")&&!!a.trashed===(url.searchParams.get("isTrashed")==="true"));
      return finish({images:all.length,videos:0,total:all.length});
    }
    if(assetMatch){
      const a=model.assets.find(a=>a.id===assetMatch[1]);return a&&visible(a,u)?finish(assetDto(a,u)):denied();
    }
    if(path.startsWith("/api/cluster-groups")){
      if(path==="/api/cluster-groups/requests")return finish(model.requests.filter(r=>r.userId===u.id).map(recordRequest));
      const requestMatch=/^\/api\/cluster-groups\/requests\/([^/]+)(\/accept)?$/.exec(path);
      if(requestMatch){
        const r=model.requests.find(r=>r.id===requestMatch[1]);if(!r)return denied();
        if(requestMatch[2]){
          if(r.userId!==u.id)return denied();
          if(!model.joinNoEffect)u.clusterGroupId=r.clusterGroupId;
        }else if(r.userId!==u.id&&r.clusterGroupId!==u.clusterGroupId)return denied();
        model.requests.splice(model.requests.indexOf(r),1);return finish(undefined,204);
      }
      const match=/^\/api\/cluster-groups\/([^/]+)\/(users|requests|leave|regenerate-people)$/.exec(path);assert.ok(match,"known cluster route");
      const group=match[1],route=match[2],member=u.clusterGroupId===group,invited=model.requests.some(r=>r.clusterGroupId===group&&r.userId===u.id);
      if(route==="leave"){
        if(!member||!backend.users.some(x=>(x as any).clusterGroupId===group&&x.id!==u.id))return denied();
        u.clusterGroupId=randomUUID();
        for(const p of model.people.filter(p=>p.owner.id===u.id&&groupPeople(p.id).some(q=>q.owner.id!==u.id))){
          if(model.leaveNoRemap)continue;
          const old=p.id;p.id=randomUUID();
          for(const f of model.faces.filter(f=>f.personId===old&&model.assets.find(a=>a.id===f.assetId)?.owner.id===u.id))f.personId=p.id;
        }return finish(undefined,204);
      }
      if(route==="requests"&&method==="PUT"){
        if(!member||body.userId===u.id||!backend.users.some(x=>x.id===body.userId))return denied();
        const prior=model.requests.find(r=>r.clusterGroupId===group&&r.userId===body.userId);
        if(prior)return finish(recordRequest(prior),200);
        const r={id:randomUUID(),clusterGroupId:group,userId:body.userId,createdAt:"2026-11-10T01:02:03.000Z"};
        if(!model.dropInvitation)model.requests.push(r);
        return finish(recordRequest(r),201);
      }
      if(!member&&!invited)return denied();
      if(route==="users")return finish(backend.users.filter(x=>(x as any).clusterGroupId===group).toSorted((a,b)=>a.id===u.id?-1:b.id===u.id?1:a.name.localeCompare(b.name)).map(publicUser));
      if(route==="requests")return finish(model.requests.filter(r=>r.clusterGroupId===group).map(recordRequest));
      return finish(undefined,204);
    }

    if(path.startsWith("/api/faces")){
      if(path==="/api/faces"&&method==="GET"){
        const a=model.assets.find(a=>a.id===url.searchParams.get("id"));if(!a||!visible(a,u))return denied();
        return finish(model.faces.filter(f=>f.assetId===a.id&&live(f)).toSorted((a,b)=>a.x-b.x).map(f=>faceDto(f,u)));
      }
      if(path==="/api/faces"&&method==="POST"){
        const a=model.assets.find(a=>a.id===body.assetId),p=person(body.personId,u);if(!a||a.owner.id!==u.id||!p)return denied();
        const f={id:randomUUID(),assetId:a.id,personId:p.id,x:body.x,y:body.y,width:body.width,height:body.height,deleted:false};model.faces.push(f);
        p.feature??=f.id;
        if(model.lostFaceReply)throw Error("simulated lost face-create acknowledgement after insert");
        return finish(undefined,201);
      }
      const id=path.split("/")[3]!;
      if(method==="DELETE"){
        const f=model.faces.find(f=>f.id===id),a=f&&model.assets.find(a=>a.id===f.assetId);
        if(!f||a?.owner.id!==u.id)return denied();
        if(body.force)model.faces.splice(model.faces.indexOf(f),1);else f.deleted=true;return finish(undefined,204);
      }
      const target=person(id,u),f=model.faces.find(f=>f.id===body.id),a=f&&model.assets.find(a=>a.id===f.assetId);
      if(!target||!f||a?.owner.id!==u.id)return denied();
      if(!model.reassignNoEffect)f.personId=target.id;
      return finish(dto(target));
    }
    if(path==="/api/people/users"){
      if(method==="GET"){
        const id=url.searchParams.get("personId");return finish(model.shares.filter(e=>(!id||e.personId===id)&&(e.from.id===u.id||e.to.id===u.id)).map(e=>({
          personId:e.personId,sharedById:e.from.id,sharedWithId:e.to.id,sharedBy:publicUser(e.from),sharedWith:publicUser(e.to),role:e.role})));
      }
      if(method==="PUT"){
        const ids=body.personIds??model.people.filter(p=>p.owner.id===u.id).map(p=>p.id);
        if(ids.some((id:string)=>!person(id,u))||body.sharedWithIds.some((id:string)=>id===u.id||!(backend.users.find(x=>x.id===id) as any)?.clusterGroupId||
          (backend.users.find(x=>x.id===id) as any)?.clusterGroupId!==u.clusterGroupId))return denied();
        for(const id of ids)for(const uid of body.sharedWithIds){
          const target=backend.users.find(x=>x.id===uid)!,p=person(id,u),role=model.shareWrongRole?"read":body.role;
          const edge=model.shares.find(e=>e.personId===id&&e.from.id===u.id&&e.to.id===uid);
          if(edge)edge.role=role;else model.shares.push({personId:id,from:u,to:target,role});
          if(!person(id,target))create(id,target,{name:p.name,birthDate:p.birthDate});
        }return finish(undefined);
      }
      if(body.some((e:any)=>!userHas(e.personId,u,backend.users.find(x=>x.id===(e.sharedById??u.id)),["write","admin"])))return denied();
      for(const item of body){
        model.shares.splice(0,model.shares.length,...model.shares.filter(e=>!(e.personId===item.personId&&e.from.id===(item.sharedById??u.id)&&e.to.id===item.sharedWithId)));
      }return finish(undefined);
    }
    const matches=(p:any,name:string|null)=>!name||p.name.toLowerCase().includes(name.toLowerCase());
    if(path==="/api/search/person")return finish(model.people.filter(p=>p.owner.id===u.id&&matches(p,url.searchParams.get("name"))&&
      (url.searchParams.get("withHidden")==="true"||!p.isHidden)).map(dto));
    if(path==="/api/people"&&method==="GET"){
      const candidates=model.people.filter(p=>p.owner.id===u.id&&accessibleFaces(p.id,u).length>0&&matches(p,url.searchParams.get("name"))&&
        (!url.searchParams.has("isHidden")||p.isHidden===(url.searchParams.get("isHidden")==="true"))&&
        (!url.searchParams.has("isFavorite")||p.isFavorite===(url.searchParams.get("isFavorite")==="true")));
      const shown=candidates.filter(p=>url.searchParams.get("withHidden")==="true"||url.searchParams.has("isHidden")||!p.isHidden)
        .toSorted((a,b)=>Number(a.isHidden)-Number(b.isHidden)||Number(b.isFavorite)-Number(a.isFavorite)||accessibleFaces(b.id,u).length-accessibleFaces(a.id,u).length||a.name.localeCompare(b.name));
      const size=Number(url.searchParams.get("size")??500),start=(Number(url.searchParams.get("page")??1)-1)*size;
      return finish({people:shown.slice(start,start+size).map(dto),total:candidates.length,hidden:candidates.filter(p=>p.isHidden).length,hasNextPage:shown.length>start+size});
    }
    if(path==="/api/people"&&method==="POST")return finish(dto(create(randomUUID(),u,body)),201);
    if(path==="/api/people"&&method==="PUT"){
      return finish(body.people.map((p:any)=>{
        const {color,...rest}=p,target=update(p.id,u,rest);
        return target?{id:p.id,success:true}:{id:p.id,success:false,error:"unknown"};
      }));
    }
    if(path==="/api/people"&&method==="DELETE"){
      const target=body.userId?backend.users.find(x=>x.id===body.userId):u;
      if(!target||body.ids.some((id:string)=>!userHas(id,u,target,["admin"])))return denied();
      remove(body.ids,target);return finish(undefined,204);
    }
    const personMatch=/^\/api\/people\/([^/]+)(\/(statistics|thumbnail|merge|reassign))?$/.exec(path);
    const mergeIds=path==="/api/people/merge"?body.ids:personMatch?.[3]==="merge"?[personMatch[1],...body.ids]:undefined;
    if(mergeIds){
      if(mergeIds.length<2||new Set(mergeIds).size!==mergeIds.length)return denied();
      const permitted=mergeIds.filter((id:string)=>person(id,u)),target=permitted[0],sources=permitted.slice(1);
      if(!model.legacyMergeNoEffect||path==="/api/people/merge"){
        for(const id of sources){
          for(const f of model.faces.filter(f=>f.personId===id&&model.assets.find(a=>a.id===f.assetId)?.owner.id===u.id))f.personId=target;
          remove([id],u);
        }
      }
      return finish(mergeIds.map((id:string)=>permitted.includes(id)?{id,success:true}:{id,success:false,error:"no_permission"}));
    }
    assert.ok(personMatch,"known person route");const id=personMatch[1]!,route=personMatch[3],p=person(id,u);
    if(method==="DELETE"){
      const target=body.userId?backend.users.find(x=>x.id===body.userId):u;
      if(!target||!userHas(id,u,target,["admin"]))return denied();remove([id],target);return finish(undefined,204);
    }
    if(method==="PUT"&&!route){const updated=update(id,u,body);return updated?finish(dto(updated)):denied();}
    if(!p)return denied();
    if(route==="statistics")return finish({assets:new Set(accessibleFaces(id,u).map(f=>f.assetId)).size});
    if(route==="thumbnail"){
      const own=p.feature&&model.faces.find(f=>f.id===p.feature),edge=model.shares.find(e=>e.personId===id&&e.to.id===u.id),
        sharedPerson=edge&&person(id,edge.from),f=own??(sharedPerson?.feature&&model.faces.find(f=>f.id===sharedPerson.feature));
      if(!f)return finish({message:"no thumbnail"},404);
      const a=model.assets.find(a=>a.id===f.assetId),name=Object.keys(oracle).find(name=>a.filename.includes(name))!;
      return new Response(new Uint8Array(model.badThumbnail?Buffer.from("invalid jpeg"):Buffer.from(oracle[name].base64,"base64")),
        {headers:{"content-type":"image/jpeg"}});
    }
    if(route==="reassign"){
      if(body.data.some((x:any)=>!person(x.personId,u)))return denied();
      for(const item of body.data)for(const f of model.faces.filter(f=>f.personId===item.personId&&f.assetId===item.assetId&&live(f))){
        if(model.assets.find(a=>a.id===f.assetId)?.owner.id===u.id)f.personId=id;
      }
      return finish(body.data.map(()=>dto(p)));
    }
    assert.equal(method,"GET");assert.equal(route,undefined);return finish(dto(p));
  }) as typeof fetch;
  return {backend,model,http};
}
