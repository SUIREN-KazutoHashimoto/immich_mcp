import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFile,mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { fixtureBackend } from "./bootstrap-harness.js";
import { Vault } from "../src/vault.js";
import { fixturePrincipal,fixtureServerId,FIXTURE_ROLES } from "../src/integration-bootstrap.js";
import { state } from "./lab-harness.js";

export function mediaBackend(){
  const base=fixtureBackend(),{backend}=base;
  const model={assets:[] as any[],albums:[] as any[],tags:[] as any[],lostUpload:false,partialBulk:false,shareNoEffect:false,corruptDownload:false};
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  const metadata=(key:any)=>({...sample(registry.schemas.ApiKeyResponseDto!),id:key.id,name:key.name,permissions:key.permissions});
  const album=(a:any)=>({...sample(registry.schemas.AlbumResponseDto!),id:a.id,albumName:a.name,description:"",assetCount:a.assets.size,
    albumUsers:[{role:"owner",user:publicUser(a.owner)},...a.viewers.map((v:any)=>({role:v.role,user:publicUser(v.user)}))],
    shared:a.viewers.length>0,hasSharedLink:false,albumThumbnailAssetId:[...a.assets][0]??null});
  const tag=(t:any)=>({...sample(registry.schemas.TagResponseDto!),id:t.id,name:t.name,value:t.name,color:t.color});
  const shared=(asset:any,user:any)=>asset.owner.id===user.id||model.albums.some(a=>a.assets.has(asset.id)&&a.viewers.some((v:any)=>v.user.id===user.id));
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(path.startsWith("/api/server/")||path.startsWith("/api/auth/")||path==="/api/admin/users"||path==="/api/api-keys/me"||path==="/api/api-keys"&&method==="POST")
      return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner;
    const record={path,method,headers,body:undefined as any};backend.calls.push(record);await backend.before?.(path,undefined);
    const finish=(value:any,status=200)=>Response.json(backend.after?.(path,value)??value,{status});
    if(!key||!user)return finish({message:"missing caller"},401);
    const limited=!key.permissions.includes("all");
    if(limited&&!(method==="GET"&&/^\/api\/assets\/[^/]+$/.test(path)&&key.permissions.includes("asset.read")))return finish({message:"permission refused"},403);
    if(path==="/api/users/me")return finish({...sample(registry.schemas.UserAdminResponseDto!),id:user.id,email:user.email,name:user.name,isAdmin:user.isAdmin});
    if(path==="/api/api-keys")return finish(backend.keys.filter(k=>k.owner.id===user.id).map(metadata));
    if(path==="/api/assets"&&method==="POST"){
      const req=new Request(url,{method,headers,body:init.body,duplex:"half"} as any),form=await req.formData(),file=form.get("assetData") as File;
      assert.ok(file instanceof File);assert.equal(file.type,"image/png");if(form.has("filename"))assert.equal(form.get("filename"),file.name);
      const sidecar=form.get("sidecarData") as File|null;
      if(sidecar&&!String(form.get("filename")||sidecar.name).endsWith(".xmp"))return finish({message:"Unsupported sidecar type"},400);
      const bytes=Buffer.from(await file.arrayBuffer()),checksum=createHash("sha1").update(bytes).digest("base64"),existing=model.assets.find(a=>a.owner.id===user.id&&a.checksum===checksum);
      record.body={fields:Object.fromEntries([...form.entries()].filter(([,v])=>typeof v==="string")),filename:file.name,size:bytes.length};
      if(existing)return finish({id:existing.id,status:"duplicate"},200);
      const a={id:randomUUID(),owner:user,filename:file.name,bytes,sidecar:sidecar?Buffer.from(await sidecar.arrayBuffer()):undefined,
        checksum,favorite:form.get("isFavorite")==="true",tags:new Set<string>()};model.assets.push(a);
      if(model.lostUpload)throw Error("simulated response loss after asset insert");
      return finish({id:a.id,status:"created"},201);
    }
    const assetMatch=/^\/api\/assets\/([^/]+)(\/original)?$/.exec(path);
    if(assetMatch){
      const a=model.assets.find(a=>a.id===assetMatch[1]);if(!a||!shared(a,user))return finish({message:"not found or no asset access"},400);
      if(assetMatch[2]){
        const bytes=model.corruptDownload?Buffer.from("wrong bytes"):a.bytes;return new Response(new Uint8Array(bytes),{headers:{"content-type":"application/octet-stream"}});
      }
      return finish({...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),originalFileName:a.filename,
        checksum:a.checksum,type:"IMAGE",isFavorite:user.id===a.owner.id&&a.favorite,visibility:"timeline",tags:[...a.tags].map(id=>tag(model.tags.find(t=>t.id===id)))});
    }
    if(path==="/api/albums"&&method==="POST"){
      const body=JSON.parse(String(init.body));record.body=body;
      const a={id:randomUUID(),owner:user,name:body.albumName,assets:new Set<string>(),viewers:[] as any[]};model.albums.push(a);return finish(album(a),201);
    }
    if(path==="/api/albums"){
      return finish(model.albums.filter(a=>(a.owner.id===user.id||a.viewers.some((v:any)=>v.user.id===user.id))&&(!url.searchParams.has("assetId")||a.assets.has(url.searchParams.get("assetId")))).map(album));
    }
    const albumMatch=/^\/api\/albums\/([^/]+)(\/(assets|users))?$/.exec(path);
    if(albumMatch){
      const a=model.albums.find(a=>a.id===albumMatch[1]);
      if(!a||!(a.owner.id===user.id||a.viewers.some((v:any)=>v.user.id===user.id)))return finish({message:"no album access"},400);
      if(!albumMatch[2])return finish(album(a));
      if(a.owner.id!==user.id)return finish({message:"owner required"},400);
      const body=JSON.parse(String(init.body));record.body=body;
      if(albumMatch[3]==="assets"){
        return finish(body.ids.map((id:string)=>{
          const asset=model.assets.find(x=>x.id===id);
          if(model.partialBulk||!asset||asset.owner.id!==user.id)return {id,success:false,error:"no_permission"};
          a.assets.add(id);return {id,success:true};
        }));
      }
      for(const item of body.albumUsers){const user=backend.users.find(u=>u.id===item.userId);assert.ok(user);if(!model.shareNoEffect)a.viewers.push({user,role:item.role});}
      return finish(album(a));
    }
    if(path==="/api/tags"&&method==="POST"){
      const body=JSON.parse(String(init.body));record.body=body;
      const t={id:randomUUID(),owner:user,name:body.name,color:body.color};model.tags.push(t);return finish(tag(t),201);
    }
    if(path==="/api/tags")return finish(model.tags.filter(t=>t.owner.id===user.id).map(tag));
    const tagMatch=/^\/api\/tags\/([^/]+)(\/assets)?$/.exec(path);
    if(tagMatch){
      const t=model.tags.find(t=>t.id===tagMatch[1]);if(!t||t.owner.id!==user.id)return finish({message:"not found or no tag access"},400);
      if(!tagMatch[2])return finish(tag(t));
      const body=JSON.parse(String(init.body));record.body=body;
      return finish(body.ids.map((id:string)=>{const a=model.assets.find(a=>a.id===id);if(!a||a.owner.id!==user.id)return {id,success:false,error:"no_permission"};a.tags.add(t.id);return {id,success:true};}));
    }
    throw Error("Unexpected feature fixture path");
  }) as typeof fetch;
  return {backend,model,http};
}
export async function seedHarnessAccounts(root:string,backend:ReturnType<typeof fixtureBackend>["backend"]){
  const s=await state(root),key=await readFile(join(root,".vault.key"));await mkdir(join(root,"fixtures"),{mode:0o700});
  const vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  const accounts=Object.fromEntries(["admin","a","b"].map(role=>[role,{id:randomUUID(),email:role+"@example.invalid",name:role,password:"password-canary-"+randomUUID(),isAdmin:role==="admin"}]));
  backend.initialized=true;backend.users.push(...Object.values(accounts));
  try{
    for(const role of FIXTURE_ROLES){
      const owner=role==="restricted"?"a":role,user=accounts[owner]!,p=fixturePrincipal(s.id,role),secret="key-canary-"+randomUUID(),id=randomUUID(),permissions=role==="restricted"?["asset.read"]:["all"];
      backend.keys.push({id,owner:user,secret,name:role,permissions});
      vault.put(p,"fixture_actor",{role,owner,principal:p,user_id:user.id},Number.MAX_SAFE_INTEGER,"actor");
      vault.put(p,"fixture_key",{owner,owner_user_id:user.id,key_id:id,permissions,secret},Number.MAX_SAFE_INTEGER,"initial_key");
      vault.replaceBinding(p,secret,id,0);
    }
    const now=new Date().toISOString();
    vault.put("__integration_fixture_bootstrap","fixture_bootstrap",{version:1,run_id:s.id,endpoint:"http://127.0.0.1:"+s.port+"/api",state:"completed",execution_scope:"harness_only",steps:[],created_at:now,updated_at:now,completed_at:now},Number.MAX_SAFE_INTEGER,"bootstrap");
  }finally{vault.close();}
}

export async function loadHarnessAccounts(root:string,backend:ReturnType<typeof fixtureBackend>["backend"]){
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{
    const users=new Map<string,any>();
    for(const role of ["admin","a","b"] as const){
      const actor=vault.get(fixturePrincipal(s.id,role),"actor","fixture_actor"),user={id:actor.user_id,email:role+"@example.invalid",name:role,password:"unused-synthetic",isAdmin:role==="admin"};
      backend.users.push(user);users.set(role,user);
    }
    for(const role of FIXTURE_ROLES){
      const key=vault.credential(fixturePrincipal(s.id,role));
      backend.keys.push({id:key.keyId,secret:key.key,name:role,permissions:role==="restricted"?["asset.read"]:["all"],owner:users.get(role==="restricted"?"a":role)});
    }
    backend.initialized=true;
  }finally{vault.close();}
}
