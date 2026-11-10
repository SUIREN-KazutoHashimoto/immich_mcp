import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { fixtureBackend } from "./bootstrap-harness.js";

interface UserState {user:any;clusterGroupId:string;profileImagePath:string;profileChangedAt:string;profile?:Buffer;avatarColor:string;storageLabel:string|null;quotaSizeInBytes:number|null;shouldChangePassword:boolean;status:string;deletedAt:string|null;preferences:any;onboarding?:boolean;}
const baseDate="2026-01-01T00:00:00.000Z";
const preferences=()=>({...sample(registry.schemas.UserPreferencesResponseDto!),ratings:{enabled:false},download:{archiveSize:4294967296,includeEmbeddedVideos:false}});
export async function userBackend(){
  const base=fixtureBackend(),{backend}=base,oracle=JSON.parse(await readFile(join(process.cwd(),"tests","profile-image-oracle.json"),"utf8"));
  const model={users:new Map<string,UserState>(),profileUploads:0,extraCreates:0,format:"jpeg" as "jpeg"|"webp",
    existingProfile:false,loseUserCreate:false,profileCorrupt:false,profileWrongOwner:false,preferencesNoPersist:false,adminUpdateNoPersist:false,restoreNoEffect:false,publicConfigWrong:false,leakPreferences:false};
  const config:any=sample(registry.schemas.UserConfigDto!);config.server.publicUsers=true;config.user.deleteDelay=7;
  const publicConfig=()=>({oauth:{...config.oauth},passwordLogin:{...config.passwordLogin},server:{loginPageMessage:config.server.loginPageMessage},theme:{...config.theme}});
  function state(user:any):UserState{
    let value=model.users.get(user.id);
    if(!value){value={user,clusterGroupId:randomUUID(),profileImagePath:model.existingProfile&&user.name==="a"?"unrelated-existing.jpeg":"",profileChangedAt:baseDate,avatarColor:"primary",storageLabel:null,quotaSizeInBytes:null,
      shouldChangePassword:false,status:"active",deletedAt:null,preferences:preferences()};model.users.set(user.id,value);}
    return value;
  }
  const publicUser=(u:UserState)=>({id:u.user.id,email:u.user.email,name:u.user.name,avatarColor:u.avatarColor,profileImagePath:u.profileImagePath,profileChangedAt:u.profileChangedAt});
  const adminUser=(u:UserState)=>({...publicUser(u),clusterGroupId:u.clusterGroupId,storageLabel:u.storageLabel,quotaSizeInBytes:u.quotaSizeInBytes,quotaUsageInBytes:0,
    shouldChangePassword:u.shouldChangePassword,isAdmin:u.user.isAdmin,status:u.status,deletedAt:u.deletedAt,createdAt:baseDate,updatedAt:baseDate,oauthId:"",license:null});
  const merged=(target:any,body:any)=>{const result=structuredClone(target);for(const [key,leaves] of Object.entries<any>(body))result[key]={...result[key],...leaves};return result;};
  const heat=(url:URL)=>({from:url.searchParams.get("from"),to:url.searchParams.get("to"),series:["2026-01-01","2026-01-02","2026-01-03"].map(date=>({date,count:0})),totalCount:0});
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(path.startsWith("/api/server/")||path==="/api/api-keys/me")return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    for(const user of backend.users)state(user);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner,who=user?state(user):undefined;
    const body=headers.get("content-type")==="application/json"?JSON.parse(String(init.body)):undefined;
    const record={path,method,headers,body};backend.calls.push(record);await backend.before?.(path,body);
    const finish=(value:any,status=200)=>Response.json(backend.after?.(path,value)??value,{status});
    const noContent=()=>new Response(null,{status:204});
    if(path==="/api/public/config"||path==="/api/public/config/defaults"){
      const value=publicConfig();if(model.publicConfigWrong)value.passwordLogin.enabled=!value.passwordLogin.enabled;return finish(value);
    }
    if(!key||!who)return finish({message:"missing caller"},401);
    if(!key.permissions.includes("all"))return finish({message:"permission refused"},403);
    if(path==="/api/config"||path==="/api/config/defaults")return finish(config);
    const adminMatch=/^\/api\/admin\/users(?:\/([^/]+)(?:\/(preferences|sessions|statistics|calendar-heatmap|restore))?)?$/.exec(path);
    if(adminMatch){
      if(!user!.isAdmin)return finish({message:"administrator required"},403);
      const id=adminMatch[1],suffix=adminMatch[2];
      if(!id&&method==="GET"){
        const selected=[...model.users.values()].filter(u=>(url.searchParams.get("withDeleted")==="true"||!u.deletedAt)&&(!url.searchParams.has("id")||u.user.id===url.searchParams.get("id")));
        return finish(selected.map(adminUser));
      }
      if(!id&&method==="POST"){
        assert.equal(body.notify,false);assert.equal(body.isAdmin,false);assert.equal(body.shouldChangePassword,false);
        assert.equal(typeof body.password,"string");assert.ok(body.password.length>20);
        if([...model.users.values()].some(u=>!u.deletedAt&&u.user.email===body.email))return finish({message:"Email is not available"},400);
        const created={id:randomUUID(),...body,isAdmin:false};backend.users.push(created);const s=state(created);model.extraCreates++;
        if(model.loseUserCreate)throw Error("simulated response loss after user insert");
        return finish(adminUser(s),201);
      }
      const target=id?model.users.get(id):undefined;if(!target)return finish({message:"not found"},404);
      if(suffix==="preferences"){
        if(method==="GET")return finish(target.preferences);
        if(target.deletedAt)return finish({message:"not found"},404);
        target.preferences=merged(target.preferences,body);return finish(target.preferences);
      }
      if(suffix==="sessions")return finish([]);
      if(suffix==="statistics")return finish({images:0,videos:0,total:0});
      if(suffix==="calendar-heatmap")return target.deletedAt?finish({message:"not found"},404):finish(heat(url));
      if(suffix==="restore"){
        const response={...adminUser(target),status:"active",deletedAt:null};if(!model.restoreNoEffect){target.status="active";target.deletedAt=null;}return finish(response);
      }
      if(method==="GET")return finish(adminUser(target));
      if(target.deletedAt)return finish({message:"not found"},404);
      if(method==="DELETE"){
        if(target.user.id===user!.id)return finish({message:"Cannot delete your own account"},403);
        target.status=body.force?"removing":"deleted";target.deletedAt=new Date().toISOString();return finish(adminUser(target));
      }
      if(method==="PUT"){
        if(body.isAdmin!==undefined&&body.isAdmin!==user!.isAdmin&&target.user.id===user!.id)return finish({message:"Admin status can only be changed by another admin"},400);
        const update=(s:UserState)=>{
          for(const field of ["name","email","isAdmin"])if(Object.hasOwn(body,field))s.user[field]=body[field];
          for(const field of ["avatarColor","storageLabel","quotaSizeInBytes","shouldChangePassword"])if(Object.hasOwn(body,field))(s as any)[field]=body[field];
          if(body.storageLabel==="")s.storageLabel=null;
        };
        if(model.adminUpdateNoPersist&&body.name){const copy={...target,user:{...target.user}};update(copy);return finish(adminUser(copy));}
        update(target);return finish(adminUser(target));
      }
    }
    if(path==="/api/users/me"&&method==="GET")return finish(adminUser(who));
    if(path==="/api/users/me"&&method==="PUT"){
      if(Object.hasOwn(body,"name"))who.user.name=body.name;return finish(adminUser(who));
    }
    if(path==="/api/users/me/preferences"){
      if(method==="GET")return finish(who.preferences);
      const result=merged(who.preferences,body);
      if(!model.preferencesNoPersist)who.preferences=result;
      if(model.leakPreferences){const other=[...model.users.values()].find(u=>u.user.id!==who.user.id&&!u.user.isAdmin);if(other)other.preferences=structuredClone(result);}
      return finish(result);
    }
    if(path==="/api/users/me/onboarding"){
      if(method==="GET")return finish({isOnboarded:who.onboarding??false});
      if(method==="DELETE"){delete who.onboarding;return noContent();}
      who.onboarding=body.isOnboarded;return finish({isOnboarded:who.onboarding});
    }
    if(path==="/api/users/me/license"){
      if(method==="DELETE")return noContent();return finish({message:"not found"},404);
    }
    if(path==="/api/users/me/calendar-heatmap")return finish(heat(url));
    if(path==="/api/users/profile-image"){
      if(method==="DELETE"){
        if(!who.profileImagePath)return finish({message:"Can't delete a missing profile Image"},400);
        who.profileImagePath="";who.profileChangedAt=new Date().toISOString();delete who.profile;return noContent();
      }
      const request=new Request(url,{method,headers,body:init.body,duplex:"half"} as any),form=await request.formData(),file=form.get("file") as File;
      assert.deepEqual([...form.keys()],["file"]);assert.ok(file instanceof File);assert.equal(file.type,"image/png");
      const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.toString("hex",0,8),"89504e470d0a1a0a");
      const index=file.name.includes("profile_a_first")?0:file.name.includes("profile_a_final")?1:2;
      const item=oracle.entries.find((e:any)=>e.id==="color_"+index+"_"+model.format);assert.ok(item);
      record.body={filename:file.name,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
      who.profile=Buffer.from(item.base64,"base64");who.profileImagePath="profile/"+user!.id+"/"+randomUUID()+"."+model.format;who.profileChangedAt=new Date().toISOString();model.profileUploads++;
      return finish({userId:user!.id,profileImagePath:who.profileImagePath,profileChangedAt:who.profileChangedAt},201);
    }
    const profile=/^\/api\/users\/([^/]+)\/profile-image$/.exec(path);
    if(profile){
      let target=model.users.get(profile[1]!);
      if(model.profileWrongOwner&&target?.user.id!==who.user.id)target=who;
      if(!target?.profile||!target.profileImagePath)return finish({message:"not found"},404);
      const bytes=model.profileCorrupt?target.profile.subarray(0,20):target.profile;
      return new Response(new Uint8Array(bytes),{headers:{"content-type":"image/"+model.format,"cache-control":"no-cache"}});
    }
    if(path==="/api/users")return finish([...model.users.values()].filter(u=>!u.deletedAt&&(user!.isAdmin||config.server.publicUsers||u.user.id===user!.id)).map(publicUser));
    const single=/^\/api\/users\/([^/]+)$/.exec(path);
    if(single){const target=model.users.get(single[1]!);return target&&!target.deletedAt?finish(publicUser(target)):finish({message:"not found"},404);}
    throw Error("Unexpected user fixture path "+method+" "+path);
  }) as typeof fetch;
  return {backend,model,http};
}
