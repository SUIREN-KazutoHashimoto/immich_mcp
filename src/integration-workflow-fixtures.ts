import {isDeepStrictEqual} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import {withInitializedFixtureLab,type FixtureRole} from "./integration-bootstrap.js";
import type {LabOptions} from "./integration-lab.js";
import {IntegrationRun,integrationFailure} from "./integration-run.js";
import {syntheticPhoto} from "./integration-media.js";
import {readDecoded} from "./content-encoding.js";
import type {ApiCall} from "./types.js";

// Dedicated disposable-lab scenario; keep actual and modeled evidence separate.
export const WORKFLOW_PLAN="workflow_plugin_fixtures_v1";
const CORE="immich-plugin-core",VERSION="2.0.1",PREFIX=CORE+"#";
const methods={
  assetFileFilter:["pattern","matchType","caseSensitive","usePath"],assetMissingTimeZoneFilter:["inverse"],
  assetLocationFilter:["region","coordinate"],assetDateFilter:["startDate","endDate","recurring"],
  assetTypeFilter:["allowedTypes"],assetAddTags:["tags"],assetTagFilter:["tags","matching"],
  assetExifFilter:["property","pattern","matchType","caseSensitive"],assetArchive:["inverse"],assetLock:["inverse"],
  assetVisibility:["visibility"],assetFavorite:["inverse"],assetAddToAlbums:["albumIds","albumName"],
  webhook:["url","headerName","headerValue","method"]
} as const;
const templates={
  "screenshots-smart-album":{trigger:"AssetCreate",methods:["assetFileFilter","assetArchive","assetAddToAlbums"]},
  "missing-timezone-smart-album":{trigger:"AssetMetadataExtraction",methods:["assetMissingTimeZoneFilter","assetAddToAlbums"]},
  "location-smart-album":{trigger:"AssetMetadataExtraction",methods:["assetLocationFilter","assetAddToAlbums"]}
} as const;
const variants=["workflow_a1","workflow_a2","workflow_b1"] as const;
type Variant=typeof variants[number];type Role="a"|"b";type Check=(ok:unknown,id:string)=>void;
type Step={method:string;config:Record<string,unknown>|null;enabled:boolean};
type Shape={trigger:string;name:string|null;description:string|null;enabled:boolean;logging:boolean;steps:Step[]};
const owner=(v:Variant):Role=>v==="workflow_b1"?"b":"a";
const user=(run:IntegrationRun,r:FixtureRole)=>run.context.actors[r].user_id;
const assetId=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v];
const flow=(run:IntegrationRun,key:string)=>run.state.data.workflows[key] as {id:string;owner:Role;shape:Shape};
const equal=(a:readonly string[],b:readonly string[])=>isDeepStrictEqual([...a].toSorted(),[...b].toSorted());
const date=(v:Variant)=>new Date(Date.UTC(2022,5,7,8,variants.indexOf(v))).toISOString();
const canary=(run:IntegrationRun)=>"WORKFLOW-CONFIG-CANARY-"+run.context.lab.state.id;
const canonical=(method:string)=>method.replace(/@[^#]*#/,"#");
async function json(run:IntegrationRun,key:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,
  assertions:string[],verify:(data:any,check:Check,result:any)=>void|Promise<void>){
  return run.execute({id:key,actor,call,status,mutates,kind:"success",assertions},(r,c)=>verify(r.data,c,r));
}
async function refused(run:IntegrationRun,key:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id:key,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},
    (r,c)=>c(r.upstream.status===status,"upstream_refusal"));
}
async function original(run:IntegrationRun,actor:FixtureRole,result:any){
  const p=run.context.actors[actor].principal,saved=run.context.vault.get(p,result.result_ref,"result");
  const bytes=await readDecoded(run.context.vault.rawStream(p,saved.raw.raw_ref),saved.raw.content_encoding??"identity",1024*1024);
  return JSON.parse(bytes.toString("utf8"));
}
async function queue(run:IntegrationRun,key:string,drained=false){
  return json(run,key,"admin",{operation_id:"getQueue",path:{name:"workflow"}},200,false,["queue_identity","queue_counters"],(data,c)=>{
    c(data.name==="workflow"&&data.isPaused===false,"queue_identity");
    c(["active","completed","failed","delayed","waiting","paused"].every(k=>Number.isSafeInteger(data.statistics[k])&&data.statistics[k]>=0)&&
      (!drained||["active","delayed","waiting","paused"].every(k=>data.statistics[k]===0)),"queue_counters");
  });
}
async function waitQueue(run:IntegrationRun,key:string){
  for(let attempt=0;attempt<20;attempt++){
    const r=await queue(run,key+"_"+attempt),s=r.data.statistics;
    if(["active","delayed","waiting","paused"].every(k=>s[k]===0))return;
    if(attempt<19)await delay(1000);
  }
  integrationFailure("fixture_queue_timeout","The workflow queue did not reach the bounded empty observation");
}
async function workflowSearch(run:IntegrationRun,key:string,role:Role,query:Record<string,unknown>,keys:string[]){
  return json(run,key,role,{operation_id:"searchWorkflows",query},200,false,["exact_owned_workflows"],(data,c)=>
    c(Array.isArray(data)&&equal(data.map((w:any)=>w.id),keys.map(k=>flow(run,k).id))&&
      data.every((w:any)=>keys.some(k=>flow(run,k).owner===role&&flow(run,k).id===w.id)),"exact_owned_workflows"));
}
async function triggers(run:IntegrationRun,key:string,actor:FixtureRole){
  return json(run,key,actor,{operation_id:"getWorkflowTriggers"},200,false,["fixed_triggers"],(data,c)=>{
    c(Array.isArray(data)&&data.length===3&&equal(data.map((x:any)=>x.trigger),["AssetCreate","AssetMetadataExtraction","AssetTagged"])&&
      data.every((x:any)=>equal(x.types,["AssetV1"])),"fixed_triggers");
  });
}
async function booleanQueryRefusals(run:IntegrationRun,prefix:string){
  // The fixed search DTOs use uncoerced z.boolean(). HTTP supplies strings.
  // Preserve false on the wire; the expected400 is source-derived, pending real-server acceptance.
  for(const [op,key] of [["searchWorkflows","enabled"],["searchWorkflows","logging"],["searchPlugins","enabled"],["searchPluginMethods","enabled"]]){
    await refused(run,prefix+"_"+op!.toLowerCase()+"_"+key,"a",{operation_id:op!,query:{[key!]:false}},400);
  }
}
async function preflight(run:IntegrationRun){
  if(run.context.vault.db.prepare("SELECT id FROM records WHERE principal=? AND kind='fixture_run' AND id!=? LIMIT 1")
    .get("__integration_feature_runs",WORKFLOW_PLAN))integrationFailure("fixture_pristine_lab","Workflow tests require a separate bootstrapped lab without other feature histories");
  for(const role of ["admin","a","b"] as const)for(const visibility of ["timeline","archive","hidden","locked"])for(const isTrashed of [false,true]){
    await json(run,"baseline_"+role+"_"+visibility+"_"+(isTrashed?"trash":"normal"),"admin",
      {operation_id:"getUserStatisticsAdmin",path:{id:user(run,role)},query:{visibility,isTrashed}},200,false,["no_owned_assets"],
      (data,c)=>c(data.total===0&&data.images===0&&data.videos===0,"no_owned_assets"));
  }
  await workflowSearch(run,"baseline_workflows_a","a",{},[]);
  await workflowSearch(run,"baseline_workflows_b","b",{},[]);
  await queue(run,"baseline_workflow_queue");
  await triggers(run,"baseline_triggers","a");
  await triggers(run,"restricted_triggers_allowed","restricted");
  await booleanQueryRefusals(run,"initial_boolean_query");
}
function coreRows(data:any[],c:Check,assertion:string,expectedId?:string){
  c(Array.isArray(data)&&data.length===1&&data[0].name===CORE&&data[0].version===VERSION&&
    typeof data[0].id==="string"&&(!expectedId||data[0].id===expectedId),assertion);
}
function methodRows(data:any[],c:Check,expected:string[],assertion:string){
  c(Array.isArray(data)&&data.length===expected.length&&equal(data.map((m:any)=>m.name),expected)&&
    data.every((m:any)=>m.key===PREFIX+m.name&&equal(m.types,["AssetV1"])&&
      m.hostFunctions===["assetAddTags","assetAddToAlbums","webhook"].includes(m.name)),assertion);
}
async function discoverCore(run:IntegrationRun){
  let found=false;
  for(let attempt=0;attempt<20;attempt++){
    const r=await json(run,"core_ready_"+attempt,"a",{operation_id:"searchPlugins",query:{name:CORE}},200,false,["core_candidates"],(data,c)=>
      c(Array.isArray(data)&&data.length<=1&&data.every((p:any)=>p.name===CORE&&p.version===VERSION),"core_candidates"));
    if(r.data.length===1){
      const p=r.data[0];run.state.data.core={id:p.id,title:p.title,description:p.description};run.save();found=true;break;
    }
    if(attempt<19)await delay(1000);
  }
  if(!found)integrationFailure("fixture_plugin_timeout","The pinned bundled core plugin did not become available");
}
async function verifyCore(run:IntegrationRun,prefix:string){
  const d=run.state.data;
  await json(run,prefix+"_plugin_a","a",{operation_id:"getPlugin",path:{id:d.core.id}},200,false,["core_identity","core_methods","core_schema_fields"],async(data,c,result)=>{
    coreRows([data],c,"core_identity",d.core.id);methodRows(data.methods,c,Object.keys(methods),"core_methods");
    const raw=await original(run,"a",result);
    c(raw.methods.every((m:any)=>m.schema&&typeof m.schema==="object"&&
      equal(Object.keys(m.schema.properties??{}),methods[m.name as keyof typeof methods])),"core_schema_fields");
  });
  for(const [suffix,actor,query] of [
    ["id","a",{id:d.core.id}],["exact","a",{name:CORE,version:VERSION,title:d.core.title,description:d.core.description}],
    ["global_b","b",{name:CORE,version:VERSION}]
  ] as const){
    await json(run,prefix+"_plugin_search_"+suffix,actor,{operation_id:"searchPlugins",query},200,false,["core_identity"],
      (data,c)=>coreRows(data,c,"core_identity",d.core.id));
  }
  for(const [suffix,query,names] of [
    ["all",{pluginName:CORE,pluginVersion:VERSION},Object.keys(methods)],
    ["favorite",{pluginName:CORE,name:"assetFavorite"},["assetFavorite"]],
    ["compatible",{pluginName:CORE,type:"AssetV1",trigger:"AssetCreate"},Object.keys(methods)]
  ] as const){
    await json(run,prefix+"_method_search_"+suffix,"a",{operation_id:"searchPluginMethods",query},200,false,["method_identity"],
      (data,c)=>methodRows(data,c,[...names],"method_identity"));
  }
  await json(run,prefix+"_templates","a",{operation_id:"searchPluginTemplates"},200,false,["core_templates"],async(_data,c,result)=>{
    const raw=await original(run,"a",result),rows=raw.filter((t:any)=>t.key.startsWith(PREFIX));
    c(rows.length===3&&equal(rows.map((t:any)=>t.key),Object.keys(templates).map(k=>PREFIX+k))&&rows.every((t:any)=>{
      const key=t.key.slice(PREFIX.length) as keyof typeof templates,want=templates[key];
      return t.trigger===want.trigger&&isDeepStrictEqual(t.steps.map((s:any)=>s.method),want.methods.map(m=>PREFIX+m));
    }),"core_templates");
  });
}

function canonicalSteps(steps:Step[]):Step[]{
  return steps.map(s=>({...structuredClone(s),method:canonical(s.method)}));
}
function stepValues(actual:any[],expected:Step[]){
  return Array.isArray(actual)&&actual.length===expected.length&&actual.every((s:any,i:number)=>{
    const e=expected[i]!;
    return s.method===e.method&&s.enabled===e.enabled&&isDeepStrictEqual(s.config,e.config);
  });
}
async function readWorkflow(run:IntegrationRun,key:string,workflowKey:string){
  const expected=flow(run,workflowKey),shape=expected.shape;
  return json(run,key,expected.owner,{operation_id:"getWorkflow",path:{id:expected.id}},200,false,
    ["workflow_fields","persisted_steps","config_private"],async(data,c,result)=>{
      c(data.id===expected.id&&["trigger","name","description","enabled","logging"].every(k=>data[k]===(shape as any)[k])&&
        Number.isFinite(Date.parse(data.createdAt))&&Number.isFinite(Date.parse(data.updatedAt)),"workflow_fields");
      const raw=await original(run,expected.owner,result);c(stepValues(raw.steps,shape.steps),"persisted_steps");
      c(!JSON.stringify(result).includes(canary(run)),"config_private");
    });
}
async function readShare(run:IntegrationRun,key:string,workflowKey:string){
  const expected=flow(run,workflowKey),s=expected.shape;
  return json(run,key,expected.owner,{operation_id:"getWorkflowForShare",path:{id:expected.id}},200,false,
    ["reduced_share","share_steps","config_private"],async(data,c,result)=>{
      c(data.trigger===s.trigger&&data.name===s.name&&data.description===s.description,"reduced_share");
      const raw=await original(run,expected.owner,result);
      c(equal(Object.keys(raw),["trigger","name","description","steps"])&&Array.isArray(raw.steps)&&raw.steps.length===s.steps.length&&
        raw.steps.every((step:any,i:number)=>{
          const want=s.steps[i]!,keys=want.enabled?["method","config"]:["method","config","enabled"];
          return equal(Object.keys(step),keys)&&step.method===want.method&&isDeepStrictEqual(step.config,want.config)&&
            (want.enabled?!Object.hasOwn(step,"enabled"):step.enabled===false);
        }),"share_steps");
      c(!JSON.stringify(result).includes(canary(run)),"config_private");
    });
}
async function createWorkflow(run:IntegrationRun,key:string,role:Role,shape:Shape){
  const r=await json(run,"create_"+key,role,{operation_id:"createWorkflow",body:shape},201,true,
    ["created_workflow","create_steps_omitted"],(data,c)=>{
      c(typeof data.id==="string"&&data.name===shape.name&&data.trigger===shape.trigger&&data.enabled===shape.enabled&&
        data.logging===shape.logging,"created_workflow");
      // The service explicitly maps create with steps:[] after repository persistence.
      c(Array.isArray(data.steps)&&data.steps.length===0,"create_steps_omitted");
    });
  run.state.data.workflows[key]={id:r.data.id,owner:role,shape:{...structuredClone(shape),steps:canonicalSteps(shape.steps)}};run.save();
}
async function updateWorkflow(run:IntegrationRun,key:string,workflowKey:string,body:Partial<Shape>){
  const existing=flow(run,workflowKey);
  await json(run,key,existing.owner,{operation_id:"updateWorkflow",path:{id:existing.id},body},200,true,["update_identity"],
    (data,c)=>c(data.id===existing.id,"update_identity"));
  existing.shape={...existing.shape,...structuredClone(body),
    steps:Object.hasOwn(body,"steps")?canonicalSteps(body.steps!):existing.shape.steps};run.save();
}
async function deleteWorkflow(run:IntegrationRun,key:string,workflowKey:string){
  const w=flow(run,workflowKey);
  await json(run,key,w.owner,{operation_id:"deleteWorkflow",path:{id:w.id}},204,true,["delete_ack"],(_data,c)=>c(true,"delete_ack"));
}
async function foreignWorkflowRefusals(run:IntegrationRun){
  for(const [role,foreign] of [["b","favorite"],["a","temporary_b"]] as const){
    const target=flow(run,foreign),prefix="foreign_"+role;
    for(const op of ["getWorkflow","getWorkflowForShare","getWorkflowLogs"]){
      await refused(run,prefix+"_"+op.toLowerCase(),role,{operation_id:op,path:{id:target.id}},400);
    }
    await refused(run,prefix+"_update",role,{operation_id:"updateWorkflow",path:{id:target.id},body:{name:"forged foreign write",enabled:true}},400,true);
    await refused(run,prefix+"_delete",role,{operation_id:"deleteWorkflow",path:{id:target.id}},400,true);
    await readWorkflow(run,prefix+"_target_preserved",foreign);
  }
}
async function setupWorkflows(run:IntegrationRun){
  const label=run.context.lab.state.id,favorite:Shape={trigger:"AssetTagged",name:"MCP favorite "+label,description:"Owned synthetic workflow",
    enabled:false,logging:true,steps:[{method:PREFIX+"assetFavorite",config:{inverse:false},enabled:true}]};
  const halted:Shape={trigger:"AssetTagged",name:"MCP halted "+label,description:null,enabled:false,logging:true,
    steps:[{method:PREFIX+"assetFileFilter",config:{pattern:"__MCP_NEVER_MATCH__"+label,matchType:"exact",caseSensitive:true,usePath:false},enabled:true}]};
  const temporary:Shape={trigger:"AssetTagged",name:"MCP temporary B "+label,description:"",enabled:false,logging:true,
    steps:[{method:CORE+"@0.0.0#assetFavorite",config:null,enabled:true}]};
  await createWorkflow(run,"favorite","a",favorite);await readWorkflow(run,"created_favorite_readback","favorite");
  await readShare(run,"favorite_share_true_default","favorite");
  await updateWorkflow(run,"replace_favorite_empty","favorite",{steps:[]});await readWorkflow(run,"empty_steps_readback","favorite");
  await updateWorkflow(run,"restore_favorite_steps","favorite",{steps:favorite.steps});await readWorkflow(run,"restored_steps_readback","favorite");
  await updateWorkflow(run,"favorite_empty_fields","favorite",{name:"",description:"",enabled:false});
  await readWorkflow(run,"empty_fields_readback","favorite");
  await updateWorkflow(run,"favorite_final_metadata","favorite",{name:"MCP \u8a66\u9a13 favorite "+label,description:null});
  await readWorkflow(run,"final_metadata_preserves_steps","favorite");
  await createWorkflow(run,"halted","a",halted);await readWorkflow(run,"created_halted_readback","halted");
  await createWorkflow(run,"temporary_b","b",temporary);await readWorkflow(run,"versioned_method_normalized","temporary_b");
  await readShare(run,"temporary_null_share","temporary_b");
  await updateWorkflow(run,"temporary_private_step","temporary_b",{steps:[
    {method:PREFIX+"assetFavorite",config:{inverse:false,fixtureCanary:canary(run)},enabled:false}]});
  await readWorkflow(run,"temporary_private_readback","temporary_b");await readShare(run,"temporary_false_share","temporary_b");
  await refused(run,"unknown_method_create_refused","a",{operation_id:"createWorkflow",body:{trigger:"AssetTagged",name:"MCP unknown "+label,
    enabled:false,logging:true,steps:[{method:"missing-plugin#missing-method",config:null,enabled:true}]}},400,true);
  await workflowSearch(run,"unknown_method_no_partial_create","a",{},["favorite","halted"]);
  await workflowSearch(run,"a_string_name_filter_source_behavior","a",{name:"__absent__"+label},["favorite","halted"]);
  await workflowSearch(run,"a_trigger_filter","a",{trigger:"AssetTagged"},["favorite","halted"]);
  await workflowSearch(run,"a_id_filter","a",{id:flow(run,"favorite").id},["favorite"]);
  await workflowSearch(run,"b_isolated_list","b",{},["temporary_b"]);
  await foreignWorkflowRefusals(run);
  await deleteWorkflow(run,"delete_temporary_b","temporary_b");
  await refused(run,"deleted_temporary_get","b",{operation_id:"getWorkflow",path:{id:flow(run,"temporary_b").id}},400);
  await refused(run,"deleted_temporary_share","b",{operation_id:"getWorkflowForShare",path:{id:flow(run,"temporary_b").id}},400);
  await refused(run,"deleted_temporary_logs","b",{operation_id:"getWorkflowLogs",path:{id:flow(run,"temporary_b").id}},400);
  await workflowSearch(run,"b_delete_readback","b",{},[]);
}

function identity(run:IntegrationRun,v:Variant,data:any){
  const p=syntheticPhoto(run.context.lab.state.id,v);
  return data.id===assetId(run,v)&&data.ownerId===user(run,owner(v))&&data.checksum===p.sha1&&
    data.originalFileName===p.filename&&data.fileCreatedAt===date(v)&&data.visibility==="timeline"&&data.isTrashed===false;
}
function metadata(run:IntegrationRun,v:Variant,data:any){
  const p=syntheticPhoto(run.context.lab.state.id,v);
  return data.exifInfo?.exifImageWidth===64&&data.exifInfo?.exifImageHeight===32&&data.exifInfo?.fileSizeInByte===p.bytes.length;
}
async function photo(run:IntegrationRun,key:string,v:Variant,favorite:boolean,tagged:boolean){
  return json(run,key,owner(v),{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,
    ["owned_photo","photo_metadata","favorite_and_tags"],(data,c)=>{
      c(identity(run,v,data),"owned_photo");c(metadata(run,v,data),"photo_metadata");
      c(data.isFavorite===favorite&&equal((data.tags??[]).map((t:any)=>t.id),tagged?[run.state.data.tags[owner(v)].id]:[]),"favorite_and_tags");
    });
}
async function upload(run:IntegrationRun){
  for(const v of variants){
    const role=owner(v),p=syntheticPhoto(run.context.lab.state.id,v),principal=run.context.actors[role].principal;
    const file=await run.staging.ingest(principal,p.filename,p.mime,(async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
    const r=await json(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",
      files:{assetData:{file_ref:file.file_ref}},body:{filename:p.filename,fileCreatedAt:date(v),fileModifiedAt:date(v),visibility:"timeline",isFavorite:false}},
      201,true,["new_upload"],(data,c)=>c(data.status==="created"&&typeof data.id==="string","new_upload"));
    run.state.data.assets[v]=r.data.id;run.save();
  }
  for(const v of variants){
    let ready=false;
    for(let attempt=0;attempt<20;attempt++){
      await json(run,"metadata_"+v+"_"+attempt,owner(v),{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,
        ["owned_initial_photo"],(data,c)=>{
          c(identity(run,v,data)&&data.isFavorite===false&&(data.tags??[]).length===0,"owned_initial_photo");
          ready=metadata(run,v,data);
        });
      if(ready)break;if(attempt<19)await delay(1000);
    }
    if(!ready)integrationFailure("fixture_metadata_timeout","Synthetic workflow photo metadata did not become ready; uploads are never replayed");
  }
}
async function createTags(run:IntegrationRun){
  for(const role of ["a","b"] as const){
    const name="MCP workflow "+role+" "+run.context.lab.state.id;
    const r=await json(run,"create_tag_"+role,role,{operation_id:"createTag",body:{name}},201,true,["created_tag"],
      (data,c)=>c(typeof data.id==="string"&&data.name===name&&data.value===name,"created_tag"));
    run.state.data.tags[role]={id:r.data.id,name};run.save();
  }
}
async function tag(run:IntegrationRun,v:Variant){
  return json(run,"trigger_tag_"+v,owner(v),{operation_id:"tagAssets",path:{id:run.state.data.tags[owner(v)].id},body:{ids:[assetId(run,v)]}},
    200,true,["tag_assignment"],(data,c)=>c(Array.isArray(data)&&data.length===1&&data[0].id===assetId(run,v)&&data[0].success===true,"tag_assignment"));
}
function logMatches(run:IntegrationRun,workflowKey:string,v:Variant,row:any){
  return typeof row.id==="string"&&Number.isFinite(Date.parse(row.at))&&row.triggerDataId===assetId(run,v)&&
    (workflowKey==="favorite"?
      row.result==="completed"&&!Object.hasOwn(row,"lastStep"):
      row.result==="halted"&&row.lastStep?.index===0&&row.lastStep?.method===run.state.data.core.id+"#assetFileFilter");
}
function validLogs(run:IntegrationRun,workflowKey:string,vs:Variant[],rows:any){
  return Array.isArray(rows)&&rows.length<=vs.length&&new Set(rows.map((r:any)=>r.id)).size===rows.length&&
    new Set(rows.map((r:any)=>r.triggerDataId)).size===rows.length&&
    rows.every((row:any,i:number)=>vs.some(v=>logMatches(run,workflowKey,v,row))&&
      (i===0||Date.parse(rows[i-1].at)>=Date.parse(row.at)));
}
async function waitLogs(run:IntegrationRun,key:string,workflowKey:string,vs:Variant[]){
  for(let attempt=0;attempt<20;attempt++){
    const r=await json(run,key+"_"+attempt,"a",{operation_id:"getWorkflowLogs",path:{id:flow(run,workflowKey).id}},200,false,
      ["bounded_owned_log_candidates"],(data,c)=>c(validLogs(run,workflowKey,vs,data),"bounded_owned_log_candidates"));
    if(r.data.length===vs.length){
      run.state.data.logs[workflowKey]=structuredClone(r.data);run.save();return;
    }
    if(attempt<19)await delay(1000);
  }
  integrationFailure("fixture_workflow_timeout","Expected owned workflow logs did not appear within the bounded observation");
}
async function logs(run:IntegrationRun,key:string,workflowKey:string,vs:Variant[],query:Record<string,unknown>={}){
  return json(run,key,"a",{operation_id:"getWorkflowLogs",path:{id:flow(run,workflowKey).id},query},200,false,
    ["exact_log_semantics","stable_log_identity"],(data,c)=>{
      c(validLogs(run,workflowKey,vs,data)&&data.length===vs.length,"exact_log_semantics");
      const expected=(run.state.data.logs[workflowKey]??[]).filter((r:any)=>vs.some(v=>r.triggerDataId===assetId(run,v)));
      c(isDeepStrictEqual(data,expected),"stable_log_identity");
    });
}
async function exerciseWorkflows(run:IntegrationRun){
  for(const v of variants)await photo(run,"before_enable_"+v,v,false,false);
  for(const key of ["favorite","halted"]){
    await logs(run,"initial_empty_logs_"+key,key,[]);
    await updateWorkflow(run,"enable_"+key,key,{enabled:true});await readWorkflow(run,"enabled_"+key+"_readback",key);
  }
  await tag(run,"workflow_a1");
  await waitLogs(run,"first_favorite","favorite",["workflow_a1"]);
  await waitLogs(run,"first_halted","halted",["workflow_a1"]);
  await waitQueue(run,"first_workflow_drain");
  await photo(run,"first_favorite_effect","workflow_a1",true,true);
  await updateWorkflow(run,"disable_favorite_logging","favorite",{logging:false});
  await readWorkflow(run,"logging_disabled_readback","favorite");
  run.state.data.logs.favorite=[];run.save();
  await logs(run,"logging_false_removed_old_logs","favorite",[]);
  await updateWorkflow(run,"restore_favorite_logging","favorite",{logging:true});
  await readWorkflow(run,"logging_restored_readback","favorite");
  await tag(run,"workflow_b1");await waitQueue(run,"foreign_workflow_drain");
  await photo(run,"foreign_photo_unaffected","workflow_b1",false,true);
  await logs(run,"foreign_trigger_no_favorite_log","favorite",[]);
  await logs(run,"foreign_trigger_no_halted_log","halted",["workflow_a1"]);
  await photo(run,"second_photo_before_trigger","workflow_a2",false,false);
  // Ensure the two independently observed halted runs have distinct millisecond timestamps.
  await delay(1000);
  await tag(run,"workflow_a2");
  await waitLogs(run,"second_favorite","favorite",["workflow_a2"]);
  await waitLogs(run,"second_halted","halted",["workflow_a1","workflow_a2"]);
  await waitQueue(run,"second_workflow_drain");
  await photo(run,"second_favorite_effect","workflow_a2",true,true);
  const halted=run.state.data.logs.halted;
  if(halted.length!==2||halted[0].triggerDataId!==assetId(run,"workflow_a2")||
    !(Date.parse(halted[0].at)>Date.parse(halted[1].at)))
    integrationFailure("fixture_log_order","Independent workflow runs did not produce distinct newest-first observations");
  for(const key of ["favorite","halted"]){
    await updateWorkflow(run,"disable_final_"+key,key,{enabled:false});await readWorkflow(run,"disabled_final_"+key+"_readback",key);
  }
}

function scopeCalls(run:IntegrationRun):{call:ApiCall;mutates:boolean}[]{
  const id=flow(run,"favorite").id,plugin=run.state.data.core.id;
  return [
    {call:{operation_id:"searchWorkflows"},mutates:false},
    {call:{operation_id:"createWorkflow",body:{...flow(run,"favorite").shape,name:"Restricted attempt"}},mutates:true},
    {call:{operation_id:"getWorkflow",path:{id}},mutates:false},
    {call:{operation_id:"getWorkflowForShare",path:{id}},mutates:false},
    {call:{operation_id:"getWorkflowLogs",path:{id}},mutates:false},
    {call:{operation_id:"updateWorkflow",path:{id},body:{enabled:true,name:"Restricted overwrite"}},mutates:true},
    {call:{operation_id:"deleteWorkflow",path:{id}},mutates:true},
    {call:{operation_id:"searchPlugins"},mutates:false},
    {call:{operation_id:"getPlugin",path:{id:plugin}},mutates:false},
    {call:{operation_id:"searchPluginMethods"},mutates:false},
    {call:{operation_id:"searchPluginTemplates"},mutates:false}
  ];
}
async function finalLogs(run:IntegrationRun){
  await logs(run,"final_favorite_logs","favorite",["workflow_a2"]);
  await logs(run,"final_halted_logs","halted",["workflow_a1","workflow_a2"]);
  await logs(run,"final_halted_limit","halted",["workflow_a2"],{limit:1});
  await logs(run,"final_halted_before","halted",["workflow_a1"],{before:run.state.data.logs.halted[0].at});
  await logs(run,"final_halted_result","halted",["workflow_a1","workflow_a2"],{result:"halted"});
  await logs(run,"final_no_error_logs","halted",[],{result:"error"});
  await logs(run,"final_favorite_result","favorite",["workflow_a2"],{result:"completed"});
}
async function verifyWorkflows(run:IntegrationRun){
  await verifyCore(run,"final_core");
  await triggers(run,"final_triggers","a");await triggers(run,"final_restricted_triggers","restricted");
  await booleanQueryRefusals(run,"final_boolean_query");
  await workflowSearch(run,"final_a_workflows","a",{},["favorite","halted"]);
  await workflowSearch(run,"final_b_workflows","b",{},[]);
  for(const key of ["favorite","halted"]){
    await readWorkflow(run,"final_get_"+key,key);await readShare(run,"final_share_"+key,key);
    await refused(run,"final_foreign_get_"+key,"b",{operation_id:"getWorkflow",path:{id:flow(run,key).id}},400);
    await refused(run,"final_foreign_logs_"+key,"b",{operation_id:"getWorkflowLogs",path:{id:flow(run,key).id}},400);
  }
  const deleted=flow(run,"temporary_b").id;
  await refused(run,"final_deleted_get","b",{operation_id:"getWorkflow",path:{id:deleted}},400);
  await refused(run,"final_deleted_share","b",{operation_id:"getWorkflowForShare",path:{id:deleted}},400);
  await refused(run,"final_deleted_logs","b",{operation_id:"getWorkflowLogs",path:{id:deleted}},400);
  for(const v of variants)await photo(run,"final_photo_"+v,v,owner(v)==="a",true);
  for(const role of ["a","b"] as const){
    const t=run.state.data.tags[role],count=role==="a"?2:1;
    await json(run,"final_tag_"+role,role,{operation_id:"getTagById",path:{id:t.id}},200,false,["owned_tag"],
      (data,c)=>c(data.id===t.id&&data.name===t.name&&data.value===t.name,"owned_tag"));
    await json(run,"final_tag_list_"+role,role,{operation_id:"getAllTags"},200,false,["exact_owned_tags"],
      (data,c)=>c(Array.isArray(data)&&data.length===1&&data[0].id===t.id,"exact_owned_tags"));
    await json(run,"final_statistics_"+role,"admin",{operation_id:"getUserStatisticsAdmin",path:{id:user(run,role)},query:{visibility:"timeline",isTrashed:false}},
      200,false,["retained_photos"],(data,c)=>c(data.total===count&&data.images===count&&data.videos===0,"retained_photos"));
  }
  await finalLogs(run);await queue(run,"final_workflow_queue",true);
  for(const {call,mutates} of scopeCalls(run)){
    if(run.revalidate&&mutates)continue;
    await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,mutates);
  }
  // A403 response must not conceal a successful restricted mutation.
  await workflowSearch(run,"after_restrictions_a_list","a",{},["favorite","halted"]);
  await workflowSearch(run,"after_restrictions_b_list","b",{},[]);
  for(const key of ["favorite","halted"])await readWorkflow(run,"after_restrictions_"+key,key);
}
export async function createWorkflowFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,WORKFLOW_PLAN,{maxCases:448});
    try{
      if(!run.revalidate){
        run.state.data={assets:{},tags:{},workflows:{},logs:{favorite:[],halted:[]}};run.save();
        await preflight(run);await discoverCore(run);await verifyCore(run,"initial_core");
        await setupWorkflows(run);await upload(run);await createTags(run);await exerciseWorkflows(run);
      }
      await verifyWorkflows(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"workflow_fixtures_revalidated":"workflow_fixtures_ready",execution_scope:run.state.execution_scope,
        created_workflows:3,retained_workflows:2,synthetic_assets:3,retained_tags:2,retained_workflow_logs:3,report,
        wasm_execution_trace_verified:false,api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Workflow completion is committed; retry only read-only validation and report publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve durable sent and completion evidence. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Owned workflow state changed; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","Workflow setup did not finish; preserve evidence and prepare a new dedicated disposable lab");
    }
  },options);
}
