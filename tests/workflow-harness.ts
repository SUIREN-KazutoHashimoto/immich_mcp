import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {discoveryBackend} from "./discovery-harness.js";
import {registry} from "../src/registry.js";
import {sample} from "./fixtures.js";
const manifest=JSON.parse(readFileSync(new URL("./workflow-core-manifest.fixture.json",import.meta.url),"utf8"));
// Pinned-source state model, not actual Immich or WASM execution.
export function workflowBackend(){
  const base=discoveryBackend(),{backend}=base;
  const model=Object.assign(base.model,{workflows:[] as any[],logs:[] as any[],pluginId:randomUUID(),ticks:Date.now(),
    restrictedWriteEffect:false,lostCreate:false,dropSteps:false,enableNoEffect:false,favoriteNoEffect:false,loggingClearNoEffect:false,
    badTriggerId:false,shareWrongDefault:false,leakList:false,queueBlocked:false,missingCoreMethod:false});
  const now=()=>new Date(model.ticks+=1000).toISOString();
  const methodDto=(m:any)=>({key:manifest.name+"#"+m.name,name:m.name,title:m.title,description:m.description,types:m.types,
    uiHints:m.uiHints??[],schema:m.schema,hostFunctions:m.hostFunctions??false});
  const core=()=>({id:model.pluginId,name:manifest.name,version:manifest.version,title:manifest.title,description:manifest.description,
    author:manifest.author,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),
    methods:(model.missingCoreMethod?manifest.methods.slice(1):manifest.methods).map(methodDto)});
  const dto=(w:any,empty=false)=>({id:w.id,trigger:w.trigger,name:w.name,description:w.description,createdAt:w.createdAt,updatedAt:w.updatedAt,
    enabled:w.enabled,logging:w.logging,steps:empty?[]:structuredClone(w.steps)});
  const normalizeSteps=(steps:any[])=>steps.map(s=>({...s,method:s.method.replace(/@[^#]*#/,"#"),enabled:s.enabled??true}));
  const validSteps=(steps:any[])=>steps.every(s=>{const [plugin,name]=s.method.replace(/@[^#]*#/,"#").split("#");
    return plugin===manifest.name&&manifest.methods.some((m:any)=>m.name===name);});
  const assetDto=(data:any,a:any)=>({...data,isFavorite:a.favorite,tags:[...a.tags].map(id=>{
    const t=model.tags.find(t=>t.id===id);return {...sample(registry.schemas.TagResponseDto!),id:t.id,name:t.name,value:t.name};
  })});
  function trigger(a:any,u:any){
    for(const w of model.workflows.filter(w=>(model.leakList&&u.name==="b"||w.owner.id===u.id)&&w.trigger==="AssetTagged"&&w.enabled)){
      let lastStep:any;
      for(const [index,s]of w.steps.entries()){
        if(!s.enabled)continue;
        if(s.method.endsWith("#assetFavorite")){if(!model.favoriteNoEffect)a.favorite=!(s.config?.inverse??false);}
        else if(s.method.endsWith("#assetFileFilter")&&a.filename!==s.config.pattern){
          lastStep={index,method:model.pluginId+"#assetFileFilter"};break;
        }else throw Error("Unmodeled core execution");
      }
      if(w.logging)model.logs.push({workflowId:w.id,id:randomUUID(),at:now(),result:lastStep?"halted":"completed",
        triggerDataId:model.badTriggerId?randomUUID():a.id,...(lastStep?{lastStep}:{})});
    }
  }
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    const handled=/^\/api\/(workflows|plugins)(\/|$)/.test(path)||path==="/api/queues/workflow"||
      /^\/api\/admin\/users\/[^/]+\/statistics$/.test(path);
    if(!handled){
      const response=await base.http(input,init);
      if(/^\/api\/tags\/[^/]+\/assets$/.test(path)&&method==="PUT"&&response.status===200){
        const result=await response.clone().json() as any,key=backend.keys.find(k=>k.secret===headers.get("x-api-key"))!;
        for(const row of result)if(row.success)trigger(model.assets.find(a=>a.id===row.id),key.owner);
      }
      const match=/^\/api\/assets\/([^/]+)$/.exec(path);
      if(match&&response.status===200){const a=model.assets.find(a=>a.id===match[1]);return Response.json(assetDto(await response.json(),a));}
      return response;
    }
    assert.equal(url.origin,"http://127.0.0.1:22835");
    for(const h of ["authorization","cookie","cf-access-jwt-assertion"])assert.equal(headers.get(h),null);
    const body=init.body?JSON.parse(String(init.body)):undefined;backend.calls.push({path,method,headers,body});await backend.before?.(path,body);
    const finish=(data:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,data)??data,{status});
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),u=key?.owner;
    if(!key||!u)return finish({message:"missing caller"},401);
    if(path==="/api/workflows/triggers")return finish(["AssetCreate","AssetMetadataExtraction","AssetTagged"].map(trigger=>({trigger,types:["AssetV1"]})));
    if(!key.permissions.includes("all")){
      if(model.restrictedWriteEffect&&method==="PUT"&&/^\/api\/workflows\/[^/]+$/.test(path)){
        const w=model.workflows.find(w=>w.id===path.split("/")[3]&&w.owner.id===u.id);if(w)Object.assign(w,{enabled:body.enabled,name:body.name});
      }
      return finish({message:"permission refused"},403);
    }
    if(path.startsWith("/api/admin/")){
      if(!u.isAdmin)return finish({message:"admin required"},403);
      const id=path.split("/")[4],q=url.searchParams,assets=model.assets.filter(a=>a.owner.id===id&&
        (a.visibility??"timeline")===(q.get("visibility")??"timeline")&&!!a.trashed===(q.get("isTrashed")==="true"));
      return finish({images:assets.length,videos:0,total:assets.length});
    }
    if(path==="/api/queues/workflow"){
      if(!u.isAdmin)return finish({message:"admin required"},403);
      return finish({name:"workflow",isPaused:false,statistics:{active:model.queueBlocked?1:0,waiting:0,delayed:0,paused:0,completed:model.logs.length,failed:0}});
    }
    const q=url.searchParams;
    if(["/api/workflows","/api/plugins","/api/plugins/methods"].includes(path)&&["enabled","logging"].some(k=>q.has(k)))
      return finish({message:"boolean string rejected by uncoerced pinned DTO"},400);
    if(path==="/api/plugins")return finish(["id","name","title","description","version"].every(k=>!q.has(k)||String((core() as any)[k])===q.get(k))?[core()]:[]);
    if(path==="/api/plugins/methods")return finish(core().methods.filter((m:any)=>
      ["name","title","description"].every(k=>!q.has(k)||m[k]===q.get(k))&&
      (!q.has("pluginName")||q.get("pluginName")===manifest.name)&&(!q.has("pluginVersion")||q.get("pluginVersion")===manifest.version)&&
      (!q.has("type")||m.types.includes(q.get("type")))));
    if(path==="/api/plugins/templates")return finish(manifest.templates.map((t:any)=>({
      key:manifest.name+"#"+t.name,title:t.title,description:t.description,trigger:t.trigger,
      steps:t.steps.map((s:any)=>({...s,config:s.config??null})),uiHints:t.uiHints??[]})));
    if(path.startsWith("/api/plugins/"))return path.split("/")[3]===model.pluginId?finish(core()):finish({message:"plugin not found"},400);
    if(path==="/api/workflows"){
      if(method==="GET")return finish(model.workflows.filter(w=>(model.leakList&&u.name==="b"||w.owner.id===u.id)&&
        (!q.has("id")||w.id===q.get("id"))&&(!q.has("trigger")||w.trigger===q.get("trigger")))
        .toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(w=>dto(w)));
      if(!validSteps(body.steps??[]))return finish({message:"unknown method"},400);
      const w={id:randomUUID(),owner:u,trigger:body.trigger,name:body.name??null,description:body.description??null,
        enabled:body.enabled??true,logging:body.logging??false,steps:model.dropSteps?[]:normalizeSteps(body.steps??[]),createdAt:now(),updatedAt:now()};
      model.workflows.push(w);if(model.lostCreate)throw Error("simulated response loss after workflow commit");return finish(dto(w,true),201);
    }
    const match=/^\/api\/workflows\/([^/]+)(\/(share|logs))?$/.exec(path);
    if(!match)throw Error("Unexpected workflow model path");
    const w=model.workflows.find(w=>w.id===match[1]&&w.owner.id===u.id);
    if(!w)return finish({message:"not found or owner access refused"},400);
    if(match[3]==="share")return finish({trigger:w.trigger,name:w.name,description:w.description,
      steps:w.steps.map((s:any)=>({method:s.method,config:s.config,...(s.enabled?(model.shareWrongDefault?{enabled:true}:{}):{enabled:false})}))});
    if(match[3]==="logs")return finish(model.logs.filter(l=>l.workflowId===w.id&&(!q.has("result")||l.result===q.get("result"))&&
      (!q.has("before")||Date.parse(l.at)<Date.parse(q.get("before")!))).toSorted((a,b)=>Date.parse(b.at)-Date.parse(a.at))
      .slice(0,Number(q.get("limit")??50)).map(({workflowId,...l})=>l));
    if(method==="GET")return finish(dto(w));
    if(method==="DELETE"){model.workflows.splice(model.workflows.indexOf(w),1);model.logs=model.logs.filter(l=>l.workflowId!==w.id);return finish(null,204);}
    if(method==="PUT"){
      if(body.steps&&!validSteps(body.steps))return finish({message:"unknown method"},400);
      for(const field of ["trigger","name","description","enabled","logging"])if(Object.hasOwn(body,field)&&!(field==="enabled"&&body.enabled&&model.enableNoEffect))w[field]=body[field];
      if(Object.hasOwn(body,"steps"))w.steps=normalizeSteps(body.steps);
      if(body.logging===false&&!model.loggingClearNoEffect)model.logs=model.logs.filter(l=>l.workflowId!==w.id);
      w.updatedAt=now();return finish(dto(w));
    }
    throw Error("Unexpected workflow model method");
  }) as typeof fetch;
  return {backend,model,http};
}
