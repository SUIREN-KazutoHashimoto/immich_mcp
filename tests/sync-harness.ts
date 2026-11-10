import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { authBackend } from "./auth-harness.js";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";

export function syncBackend(){
  const base=authBackend(),{backend}=base;
  const model=Object.assign(base.model,{childInfo:new Map<string,any>(),checkpoints:new Map<string,Map<string,string>>(),
    assetVersions:new Map<string,number>(),paddingAssets:new Map<string,any[]>(),clock:Date.now(),padding:20,
    ownerScopedAcks:false,ackNoEffect:false,loseAck:false,streamLeak:false,brokenStream:false,missingTerminal:false,
    streamCalls:0,childCreates:0});
  const tick=()=>++model.clock;
  const uuid7=(n:number)=>{const h=n.toString(16).padStart(12,"0");return h.slice(0,8)+"-"+h.slice(8)+"-7000-8000-000000000000";};
  const idValue=(value:string|undefined)=>value?Number.parseInt(value.replaceAll("-","").slice(0,12),16):0;
  const sessionData=(token:string,current:string|undefined)=>{
    let id=model.sessionIds.get(token);if(!id){id=randomUUID();model.sessionIds.set(token,id);}
    const info=model.childInfo.get(token);
    return {...sample(registry.schemas.SessionResponseDto!),id,current:token===current,deviceType:info?.deviceType??"Synthetic parent",
      deviceOS:info?.deviceOS??"Synthetic integration",isPendingSyncReset:info?.pending??false};
  };
  const assetData=(asset:any)=>({...sample(registry.schemas.SyncAssetV2!),id:asset.id,ownerId:asset.owner.id,checksum:asset.checksum,
    originalFileName:asset.filename,type:"IMAGE",isFavorite:!!asset.favorite,visibility:asset.visibility??"timeline"});
  const ownPadding=(user:any)=>{
    let rows=model.paddingAssets.get(user.id);
    if(!rows){rows=Array.from({length:model.padding},(_,i)=>({version:tick(),data:{...sample(registry.schemas.SyncAssetV2!),id:randomUUID(),
      ownerId:user.id,originalFileName:"prior-synthetic-\u96ea-"+i+".png",checksum:Buffer.from("synthetic-"+i).toString("base64"),isFavorite:false,type:"IMAGE",visibility:"timeline"}}));model.paddingAssets.set(user.id,rows);}
    return rows;
  };
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    const sessionPath=path==="/api/sessions"||/^\/api\/sessions\/[^/]+$/.test(path),syncPath=path.startsWith("/api/sync/"),
      assetUpdate=method==="PUT"&&/^\/api\/assets\/[^/]+$/.test(path);
    if(!sessionPath&&!syncPath&&!assetUpdate){
      const response=await base.http(input,init);
      if(path==="/api/assets"&&method==="POST"&&response.status===201){const id=(await response.clone().json()).id;model.assetVersions.set(id,tick());}
      return response;
    }
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    assert.equal(["authorization","x-api-key","x-immich-share-key","x-immich-share-slug"].filter(name=>headers.has(name)).length,1);
    const token=headers.get("authorization")?.replace(/^Bearer /,""),sessionUser=token?backend.sessions.get(token):undefined,
      key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=sessionUser??key?.owner;
    const body=typeof init.body==="string"?JSON.parse(init.body):undefined;
    backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(value:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,value)??value,{status});
    if(!user)return finish({message:"no caller"},401);
    if(key&&!key.permissions.includes("all"))return finish({message:"scope refused"},403);
    if(assetUpdate){
      const id=path.split("/").at(-1),asset=model.assets.find(a=>a.id===id&&a.owner.id===user.id);if(!asset)return finish({message:"no asset"},400);
      assert.equal(typeof body.isFavorite,"boolean");asset.favorite=body.isFavorite;model.assetVersions.set(asset.id,tick());
      return finish({...sample(registry.schemas.AssetResponseDto!),id:asset.id,ownerId:user.id,originalFileName:asset.filename,checksum:asset.checksum,
        isFavorite:asset.favorite,type:"IMAGE",visibility:"timeline"});
    }
    if(path==="/api/sessions"){
      if(method==="POST"){
        if(!sessionUser||!token)return finish({message:"session required"},400);
        const child="child-session-canary-"+randomBytes(24).toString("base64url"),id=randomUUID();
        backend.sessions.set(child,user);model.sessionIds.set(child,id);model.childInfo.set(child,{...body,parent:token,pending:false});model.childCreates++;
        return finish({...sessionData(child,undefined),token:child,expiresAt:new Date(Date.now()+body.duration*1000).toISOString()},201);
      }
      return finish([...backend.sessions].filter(([,u])=>u.id===user.id).map(([s])=>sessionData(s,token)));
    }
    if(sessionPath){
      const id=path.split("/").at(-1),entry=[...backend.sessions].find(([s,u])=>u.id===user.id&&model.sessionIds.get(s)===id);
      if(!entry)return finish({message:"not owned"},400);
      assert.equal(method,"PUT");const info=model.childInfo.get(entry[0]);assert.ok(info);info.pending=body.isPendingSyncReset;
      return finish(sessionData(entry[0],token));
    }
    if(!sessionUser||!token)return finish({message:"Sync endpoints cannot be used with API keys"},403);
    const sessionId=sessionData(token,token).id,scope=model.ownerScopedAcks?user.id:sessionId;
    let acks=model.checkpoints.get(scope);if(!acks){acks=new Map();model.checkpoints.set(scope,acks);}
    const reset=()=>{acks!.clear();const info=model.childInfo.get(token);if(info)info.pending=false;};
    if(path==="/api/sync/ack"){
      if(method==="GET")return finish([...acks].map(([type,ack])=>({type,ack})));
      if(method==="DELETE"){if(body.types)for(const type of body.types)acks.delete(type);else acks.clear();return finish(null,204);}
      assert.equal(method,"POST");
      for(const ack of body.acks){
        const type=ack.split("|",1)[0];
        if(type==="SyncResetV1"){reset();return finish(null,204);}
        if(!(registry.schemas.SyncEntityType!.enum as string[]).includes(type))return finish({message:"invalid ack type"},400);
      }
      if(!model.ackNoEffect)for(const ack of body.acks)acks.set(ack.split("|",1)[0],ack);
      if(model.loseAck)throw Error("response lost after checkpoint commit");
      return finish(null,204);
    }
    assert.equal(path,"/api/sync/stream");assert.equal(method,"POST");model.streamCalls++;
    if(body.reset)reset();
    const records:any[]=[],complete=acks.get("SyncCompleteV1"),old=complete&&idValue(complete.split("|")[1])<Date.now()-30*86400000;
    if(model.childInfo.get(token)?.pending||old)records.push({type:"SyncResetV1",data:{},ack:"SyncResetV1|reset"});
    else{
      const padding=ownPadding(user),now=tick();
      if(body.types.includes("AuthUsersV2")&&!acks.has("AuthUserV2")){
        records.push({type:"AuthUserV2",data:{...sample(registry.schemas.SyncAuthUserV2!),id:user.id,name:user.name,
          email:user.email,isAdmin:user.isAdmin,pinCode:"SYNC-PIN-CANARY-"+user.id},ack:"AuthUserV2|"+uuid7(now-1)});
      }
      if(body.types.includes("AssetsV2")){
        const threshold=idValue(acks.get("AssetV2")?.split("|")[1]);
        const rows=[...padding,...model.assets.filter(a=>a.owner.id===user.id||model.streamLeak).map(a=>({version:model.assetVersions.get(a.id)??0,data:assetData(a)}))]
          .filter(a=>a.version>threshold&&a.version<now).sort((a,b)=>a.version-b.version);
        for(const row of rows)records.push({type:"AssetV2",data:row.data,ack:"AssetV2|"+uuid7(row.version)});
      }
      if(!model.missingTerminal)records.push({type:"SyncCompleteV1",data:{},ack:"SyncCompleteV1|"+uuid7(now)});
    }
    const encoded=Buffer.from(records.map(value=>JSON.stringify(value)+"\n").join(""));
    const chunks=async function*(){for(let i=0;i<encoded.length;i+=17)yield encoded.subarray(i,i+17);if(model.brokenStream)throw Error("synthetic sync disconnect");};
    return new Response(Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>,{headers:{"content-type":"application/jsonlines+json"}});
  }) as typeof fetch;
  return {backend,model,http};
}
