import assert from "node:assert/strict";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { mediaBackend,seedHarnessAccounts } from "./media-harness.js";
import { Vault } from "../src/vault.js";
import { fixturePrincipal,fixtureServerId } from "../src/integration-bootstrap.js";
import { state } from "./lab-harness.js";

export function authBackend(){
  const base=mediaBackend(),{backend}=base;
  const model=Object.assign(base.model,{links:[] as any[],pins:new Map<string,string>(),elevated:new Set<string>(),sessionIds:new Map<string,string>(),
    loseUnlock:false,fakeUnlock:false,ignoreRelock:false,cookieLeak:false,anyLinkAuthenticated:false});
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const image=(a:any,user:any)=>({...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),originalFileName:a.filename,
    checksum:a.checksum,type:"IMAGE",isFavorite:user?.id===a.owner.id&&a.favorite,visibility:a.visibility??"timeline",tags:[]});
  const linkResponse=(l:any)=>({...sample(registry.schemas.SharedLinkResponseDto!),id:l.id,userId:l.owner.id,key:l.key,password:l.password,slug:l.slug,
    assets:l.assets.map((id:string)=>image(model.assets.find(a=>a.id===id),l.owner)),type:"INDIVIDUAL",expiresAt:l.expiresAt,createdAt:l.createdAt,
    allowDownload:l.allowDownload,allowUpload:l.allowUpload,showMetadata:true,description:null});
  const linkToken=(l:any)=>createHash("sha256").update(l.id+"-"+l.password).digest("base64");
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(path.startsWith("/api/server/")||["/api/auth/admin-sign-up","/api/auth/login","/api/admin/users","/api/api-keys/me"].includes(path)
      ||path==="/api/api-keys"&&method==="POST"||path==="/api/assets"&&method==="POST")return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");
    assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const credentialNames=["x-api-key","authorization","x-immich-share-key","x-immich-share-slug"].filter(name=>headers.has(name));
    assert.equal(credentialNames.length,1,"exactly one upstream credential");
    const isShare=headers.has("x-immich-share-key")||headers.has("x-immich-share-slug");
    if(!isShare)assert.equal(headers.get("cookie"),null);
    else if(headers.has("cookie"))assert.match(headers.get("cookie")!,/^immich_shared_link_token=[^;]+$/);
    const body=typeof init.body==="string"?JSON.parse(init.body):undefined;
    backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(value:any,status=200,extra?:HeadersInit)=>status===204?new Response(null,{status}):
      Response.json(backend.after?.(path,value)??value,{status,headers:extra});
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key"));
    const session=headers.get("authorization")?.replace(/^Bearer /,""),sessionUser=session?backend.sessions.get(session):undefined;
    const link=isShare?model.links.find(l=>headers.get("x-immich-share-key")===l.key||headers.get("x-immich-share-slug")===l.slug):undefined;
    const user=link?.owner??sessionUser??key?.owner;
    if(!user||isShare&&(!link||link.expiresAt&&new Date(link.expiresAt).getTime()<=Date.now()))return finish({message:"authentication refused"},401);
    const limited=key&&!key.permissions.includes("all");
    if(limited&&!(method==="GET"&&/^\/api\/assets\/[^/]+$/.test(path)&&key.permissions.includes("asset.read")))return finish({message:"permission refused"},403);
    const keyId=/^\/api\/api-keys\/([^/]+)$/.exec(path);
    if(keyId){
      const candidate=backend.keys.find(k=>k.id===keyId[1]&&k.owner.id===user.id);
      if(!candidate)return finish({message:"not owned"},404);
      return finish({...sample(registry.schemas.ApiKeyResponseDto!),id:candidate.id,name:candidate.name,permissions:candidate.permissions});
    }
    if(path==="/api/sessions"){
      return finish([...backend.sessions].filter(([,owner])=>owner.id===user.id).map(([token])=>{
        let id=model.sessionIds.get(token);if(!id){id=randomUUID();model.sessionIds.set(token,id);}
        return {...sample(registry.schemas.SessionResponseDto!),id,current:token===session};
      }));
    }
    if(path==="/api/auth/status")return finish({password:true,pinCode:model.pins.has(user.id),isElevated:!!session&&model.elevated.has(session)});
    if(path==="/api/auth/pin-code"&&method==="POST"){
      if(model.pins.has(user.id))return finish({message:"already has PIN"},400);
      model.pins.set(user.id,body.pinCode);return finish(null,204);
    }
    if(path==="/api/auth/session/unlock"){
      if(!sessionUser||!session)return finish({message:"session required"},400);
      if(!model.pins.has(user.id)||body.pinCode!==model.pins.get(user.id))return finish({message:"wrong PIN"},400);
      if(!model.fakeUnlock)model.elevated.add(session);
      if(model.loseUnlock)throw Error("simulated response loss after session elevation");
      return finish(null,204);
    }
    if(path==="/api/auth/session/lock"){
      if(!sessionUser||!session)return finish({message:"session required"},400);
      if(!model.ignoreRelock)model.elevated.delete(session);return finish(null,204);
    }
    const assetMatch=/^\/api\/assets\/([^/]+)(\/original)?$/.exec(path);
    if(assetMatch){
      const a=model.assets.find(a=>a.id===assetMatch[1]),allowed=!!a&&(link?link.assets.includes(a.id)&&(!assetMatch[2]||link.allowDownload):
        a.owner.id===user.id&&((a.visibility??"timeline")!=="locked"||!!session&&model.elevated.has(session)));
      if(!allowed)return finish({message:"not found or no asset access"},400);
      if(method==="PUT"){
        if(link||a.owner.id!==user.id)return finish({message:"not owner"},400);
        a.visibility=body.visibility;return finish(image(a,user));
      }
      if(assetMatch[2])return new Response(new Uint8Array(model.corruptDownload?Buffer.from("incorrect original"):a.bytes),{headers:{"content-type":"application/octet-stream"}});
      return finish(image(a,user));
    }
    if(path==="/api/shared-links"&&method==="POST"){
      const assets=body.assetIds.map((id:string)=>model.assets.find(a=>a.id===id));
      if(assets.some((a:any)=>!a||a.owner.id!==user.id||a.visibility==="locked"))return finish({message:"asset not shareable"},400);
      const item={id:randomUUID(),owner:user,key:randomBytes(50).toString("base64url"),password:body.password,slug:body.slug??null,
        assets:body.assetIds,allowDownload:body.allowDownload,allowUpload:body.allowUpload,expiresAt:body.expiresAt??null,createdAt:new Date().toISOString()};
      model.links.push(item);return finish(linkResponse(item),201);
    }
    if(path==="/api/shared-links/login"){
      if(!link)return finish({message:"link context required"},403);
      if(body.password!==link.password)return finish({message:"invalid password"},401);
      const old=headers.get("cookie")?.slice("immich_shared_link_token=".length)??"",tokens=old?decodeURIComponent(old).split(","):[];
      if(!tokens.includes(linkToken(link)))tokens.push(linkToken(link));
      model.anyLinkAuthenticated=true;
      return finish(linkResponse(link),201,[["set-cookie","immich_shared_link_token="+encodeURIComponent(tokens.join(","))+"; HttpOnly; Path=/api"],
        ["set-cookie","immich_access_token=OTHER-SESSION-CANARY; Path=/"]]);
    }
    if(path==="/api/shared-links/me"){
      if(!link)return finish({message:"link context required"},403);
      const cookie=headers.get("cookie")?.slice("immich_shared_link_token=".length)??"";
      if(!decodeURIComponent(cookie).split(",").includes(linkToken(link))&&!(model.cookieLeak&&model.anyLinkAuthenticated))return finish({message:"password required"},401);
      return finish(linkResponse(link));
    }
    const sharedId=/^\/api\/shared-links\/([^/]+)$/.exec(path);
    if(sharedId&&method==="PATCH"){
      const found=model.links.find(l=>l.id===sharedId[1]&&l.owner.id===user.id);if(!found)return finish({message:"not owned"},404);
      if(Object.hasOwn(body,"password"))found.password=body.password;
      found.slug=body.slug??null;if(Object.hasOwn(body,"expiresAt"))found.expiresAt=body.expiresAt;
      return finish(linkResponse(found));
    }
    throw Error("Unexpected authentication fixture path");
  }) as typeof fetch;
  return {backend,model,http};
}
export async function seedAuthAccounts(root:string,backend:ReturnType<typeof authBackend>["backend"]){
  await seedHarnessAccounts(root,backend);
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{
    for(const role of ["admin","a","b"] as const){
      const p=fixturePrincipal(s.id,role),actor=vault.get(p,"actor","fixture_actor"),user=backend.users.find(u=>u.id===actor.user_id)!;
      const session="session-canary-"+randomUUID();backend.sessions.set(session,user);actor.session=session;
      vault.put(p,"fixture_actor",actor,Number.MAX_SAFE_INTEGER,"actor");
    }
  }finally{vault.close();}
}
