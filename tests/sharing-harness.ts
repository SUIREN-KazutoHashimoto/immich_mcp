import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { mediaBackend } from "./media-harness.js";

function storedArchive(files:{name:string;bytes:Buffer}[]){
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name,"utf8"),crc=crc32(file.bytes),header=Buffer.alloc(30),descriptor=Buffer.alloc(16),central=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0808,6);header.writeUInt16LE(name.length,26);
    descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(file.bytes.length,8);descriptor.writeUInt32LE(file.bytes.length,12);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0808,8);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(file.bytes.length,20);central.writeUInt32LE(file.bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    locals.push(header,name,file.bytes,descriptor);centrals.push(central,name);offset+=header.length+name.length+file.bytes.length+descriptor.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export function sharingBackend(){
  const base=mediaBackend(),{backend}=base,model={...base.model,activities:[] as any[],partners:[] as any[],archives:0,
    losePartner:false,duplicateAddsRow:false,partnerWrongDirection:false,removeNoEffect:false,corruptZip:false};
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const asset=(a:any)=>({...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),originalFileName:a.filename,
    type:"IMAGE",visibility:"timeline",checksum:a.checksum,isFavorite:a.favorite,tags:[],exifInfo:{...sample(registry.schemas.ExifResponseDto!),fileSizeInByte:a.bytes.length,exifImageWidth:64,exifImageHeight:32}});
  const album=(a:any)=>({...sample(registry.schemas.AlbumResponseDto!),id:a.id,albumName:a.name,assetCount:a.assets.size,albumThumbnailAssetId:[...a.assets][0]??null,
    isActivityEnabled:a.activity??true,shared:a.viewers.length>0,albumUsers:[{role:"owner",user:publicUser(a.owner)},...a.viewers.map((v:any)=>({role:v.role,user:publicUser(v.user)}))]});
  const member=(a:any,u:any)=>!!a&&(a.owner.id===u.id||a.viewers.some((v:any)=>v.user.id===u.id));
  const readable=(a:any,u:any)=>!!a&&(a.owner.id===u.id||model.albums.some(album=>album.assets.has(a.id)&&member(album,u))||model.partners.some(p=>p.from.id===a.owner.id&&p.to.id===u.id));
  let sequence=0;
  const activity=(a:any)=>({id:a.id,createdAt:a.createdAt,user:publicUser(a.owner),assetId:a.assetId,type:a.type,comment:a.comment});
  const partner=(p:any,peer:any)=>({...publicUser(peer),inTimeline:p.inTimeline});
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    const ours=path.startsWith("/api/activities")||path.startsWith("/api/partners")||path.startsWith("/api/download/")||
      /^\/api\/assets\/[^/]+$/.test(path)||/^\/api\/albums\/[^/]+$/.test(path)&&method==="PATCH";
    if(!ours){
      const response=await base.http(input,init);
      if(path.startsWith("/api/albums")&&[200,201].includes(response.status)){
        const data=await response.clone().json() as any;
        if(data&&typeof data.id==="string"&&data.albumUsers){const a=model.albums.find(a=>a.id===data.id);if(a)return Response.json(album(a),{status:response.status});}
      }
      return response;
    }
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner,body=init.body?JSON.parse(String(init.body)):undefined;
    backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(value:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,value)??value,{status});
    const denied=()=>finish({message:"not found or no access"},400);
    if(!key||!user)return finish({message:"missing caller"},401);
    const limited=!key.permissions.includes("all");
    if(limited&&!(method==="GET"&&/^\/api\/assets\/[^/]+$/.test(path)&&key.permissions.includes("asset.read")))return finish({message:"permission refused"},403);
    if(/^\/api\/assets\/[^/]+$/.test(path)){
      const a=model.assets.find(a=>a.id===path.split("/").at(-1));if(!readable(a,user))return denied();
      if(method==="PUT"){if(a.owner.id!==user.id)return denied();if(body.isFavorite!==undefined)a.favorite=body.isFavorite;}
      return finish(asset(a));
    }
    if(/^\/api\/albums\/[^/]+$/.test(path)){
      const a=model.albums.find(a=>a.id===path.split("/").at(-1));if(!a||a.owner.id!==user.id)return denied();
      a.activity=body.isActivityEnabled;return finish(album(a));
    }
    if(path==="/api/activities"||path==="/api/activities/statistics"){
      const albumId=body?.albumId??url.searchParams.get("albumId"),a=model.albums.find(a=>a.id===albumId);if(!member(a,user))return denied();
      if(method==="POST"){
        if(a.activity===false)return denied();
        if(body.type==="comment"&&(!body.comment||!body.comment.trim())||body.type!=="comment"&&body.comment)return finish({message:"invalid comment"},400);
        const prior=body.type==="like"?model.activities.find(x=>x.albumId===a.id&&x.owner.id===user.id&&x.type==="like"&&x.assetId===(body.assetId??null)):undefined;
        if(prior){if(model.duplicateAddsRow)model.activities.push({...prior,id:randomUUID()});return finish(activity(prior),200);}
        const item={id:randomUUID(),createdAt:new Date(Date.UTC(2026,0,2,3,4,sequence++)).toISOString(),albumId:a.id,owner:user,type:body.type,assetId:body.assetId??null,comment:body.comment??null};model.activities.push(item);return finish(activity(item),201);
      }
      let rows=model.activities.filter(x=>x.albumId===a.id),q=url.searchParams;
      if(path.endsWith("/statistics")){
        if(q.has("assetId"))rows=rows.filter(x=>x.assetId===q.get("assetId"));
        return finish({comments:rows.filter(x=>x.type==="comment").length,likes:rows.filter(x=>x.type==="like").length});
      }
      if(q.get("level")==="album")rows=rows.filter(x=>x.assetId===null);else if(q.has("assetId"))rows=rows.filter(x=>x.assetId===q.get("assetId"));
      if(q.has("type"))rows=rows.filter(x=>x.type===q.get("type"));if(q.has("userId"))rows=rows.filter(x=>x.owner.id===q.get("userId"));
      return finish(rows.map(activity));
    }
    if(path.startsWith("/api/activities/")){
      const item=model.activities.find(a=>a.id===path.split("/").at(-1)),a=model.albums.find(a=>a.id===item?.albumId);
      if(!item||item.owner.id!==user.id&&a?.owner.id!==user.id)return denied();
      model.activities.splice(model.activities.indexOf(item),1);return finish(null,204);
    }
    if(path==="/api/partners"&&method==="GET"){
      const outgoing=url.searchParams.get("direction")==="shared-by";
      return finish(model.partners.filter(p=>(outgoing?p.from:p.to).id===user.id).map(p=>partner(p,outgoing?p.to:p.from)));
    }
    if(path.startsWith("/api/partners")){
      const peerId=body?.sharedWithId??path.split("/").at(-1),peer=backend.users.find(u=>u.id===peerId);
      if(method==="POST"){
        if(!peer||model.partners.some(p=>p.from.id===user.id&&p.to.id===peer.id))return denied();
        const p={from:model.partnerWrongDirection?peer:user,to:model.partnerWrongDirection?user:peer,inTimeline:false};model.partners.push(p);
        if(model.losePartner)throw Error("response lost after partner creation");return finish(partner(p,peer),201);
      }
      if(method==="PUT"){
        const p=model.partners.find(p=>p.from.id===peerId&&p.to.id===user.id);if(!p)return denied();p.inTimeline=body.inTimeline;return finish(partner(p,p.from));
      }
      if(method==="DELETE"){
        const p=model.partners.find(p=>p.from.id===user.id&&p.to.id===peerId);if(!p)return denied();
        if(!model.removeNoEffect)model.partners.splice(model.partners.indexOf(p),1);return finish(null,204);
      }
    }
    if(path==="/api/download/info"){
      let assets:any[];
      if(body.assetIds){if(body.assetIds.some((id:string)=>!readable(model.assets.find(a=>a.id===id),user)))return denied();assets=model.assets.filter(a=>body.assetIds.includes(a.id));}
      else if(body.albumId){const a=model.albums.find(a=>a.id===body.albumId);if(!member(a,user))return denied();assets=model.assets.filter(x=>a.assets.has(x.id));}
      else if(body.userId){if(body.userId!==user.id)return denied();assets=model.assets.filter(a=>a.owner.id===user.id);}
      else return denied();
      const archives:{assetIds:string[];size:number}[]=[],target=body.archiveSize??4*1024*1024*1024;let current={assetIds:[] as string[],size:0};
      for(const a of assets){current.assetIds.push(a.id);current.size+=a.bytes.length;if(current.size>target){archives.push(current);current={assetIds:[],size:0};}}
      if(current.assetIds.length)archives.push(current);return finish({archives,totalSize:archives.reduce((n,g)=>n+g.size,0)},201);
    }
    if(path==="/api/download/archive"){
      if(body.assetIds.some((id:string)=>!readable(model.assets.find(a=>a.id===id),user)))return denied();
      const counts=new Map<string,number>(),files=body.assetIds.map((id:string)=>{
        const a=model.assets.find(a=>a.id===id),count=counts.get(a.filename)??0;counts.set(a.filename,count+1);
        return {name:count?a.filename.slice(0,-4)+"+"+count+".png":a.filename,bytes:a.bytes};
      }),zip=storedArchive(files);model.archives++;
      if(model.corruptZip){const pos=30+zip.readUInt16LE(26);zip.writeUInt8(zip.readUInt8(pos)^1,pos);}
      return new Response(new Uint8Array(zip),{headers:{"content-type":"application/octet-stream"}});
    }
    throw Error("Unexpected sharing harness route "+method+" "+path);
  }) as typeof fetch;
  return {backend,model,http};
}
