import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";

interface User {id:string;email:string;name:string;password:string;isAdmin:boolean;}
interface Key {id:string;owner:User;secret:string;name:string;permissions:string[];}
export function fixtureBackend(){
  const backend={initialized:false,calls:[] as {path:string;method:string;headers:Headers;body:any}[],users:[] as User[],keys:[] as Key[],sessions:new Map<string,User>(),
    before:undefined as undefined|((path:string,body:any)=>void|Promise<void>),
    after:undefined as undefined|((path:string,value:any)=>any),
    failKeyResponse:false,keyProbeDenied:false};
  const userResponse=(user:User)=>({...sample(registry.schemas.UserAdminResponseDto!),id:user.id,email:user.email,name:user.name,isAdmin:user.isAdmin});
  const metadata=(key:Key)=>({...sample(registry.schemas.ApiKeyResponseDto!),id:key.id,name:key.name,permissions:key.permissions});
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,headers=new Headers(init.headers),method=init.method??"GET";
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.ok(["manual","error"].includes(init.redirect));assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const body=init.body?JSON.parse(String(init.body)):undefined;
    backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(value:any,status=200)=>Response.json(backend.after?.(path,value)??value,{status});
    if(path==="/api/server/version")return finish({major:3,minor:3,patch:5,prerelease:null});
    if(path==="/api/server/config"){assert.equal(headers.get("x-api-key"),null);return finish({...sample(registry.schemas.ServerConfigDto!),isInitialized:backend.initialized});}
    if(path==="/api/auth/admin-sign-up"){
      assert.equal(headers.get("authorization"),null);assert.equal(headers.get("x-api-key"),null);assert.equal(method,"POST");
      if(backend.initialized)return finish({message:"already initialized"},400);
      const user={id:randomUUID(),...body,isAdmin:true};backend.users.push(user);backend.initialized=true;return finish(userResponse(user),201);
    }
    if(path==="/api/auth/login"){
      assert.equal(headers.get("authorization"),null);assert.equal(headers.get("x-api-key"),null);assert.equal(method,"POST");
      const user=backend.users.find(u=>u.email===body.email&&u.password===body.password);
      if(!user)return finish({message:"bad login"},401);
      const token="session-canary-"+randomUUID();backend.sessions.set(token,user);
      return finish({...sample(registry.schemas.LoginResponseDto!),accessToken:token,isAdmin:user.isAdmin,name:user.name,userEmail:user.email,userId:user.id},201);
    }
    if(path==="/api/admin/users"){
      assert.equal(headers.get("authorization"),null);const key=backend.keys.find(k=>k.secret===headers.get("x-api-key"));
      if(!key?.owner.isAdmin)return finish({message:"denied"},403);
      assert.equal(body.isAdmin,false);assert.equal(body.notify,false);assert.equal(body.shouldChangePassword,false);
      const user={id:randomUUID(),...body,isAdmin:false};backend.users.push(user);return finish(userResponse(user),201);
    }
    if(path==="/api/api-keys"&&method==="POST"){
      assert.equal(headers.get("x-api-key"),null);assert.equal(headers.get("cookie"),null);
      const user=backend.sessions.get(headers.get("authorization")?.replace(/^Bearer /,"")??"");
      if(!user)return finish({message:"no own session"},401);
      const key={id:randomUUID(),owner:user,secret:"key-canary-"+randomUUID(),name:body.name,permissions:body.permissions};backend.keys.push(key);
      if(backend.failKeyResponse)throw Error("connection failed after create; hidden-canary-"+key.secret);
      return finish({...metadata(key),apiKey:metadata(key),secret:key.secret},201);
    }
    if(path==="/api/api-keys/me"){
      assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);
      const key=backend.keys.find(k=>k.secret===headers.get("x-api-key"));
      if(!key||backend.keyProbeDenied)return finish({message:"key refused; error-canary"},401);
      return finish(metadata(key));
    }
    throw Error("Unexpected bootstrap HTTP path");
  }) as typeof fetch;
  return {backend,http};
}
