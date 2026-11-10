import { setTimeout as delay } from "node:timers/promises";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto,FIXTURE_DATE } from "./integration-media.js";
import type { ApiCall } from "./types.js";

export const COLLECTION_PLAN="collection_fixtures_v1";
const variants=["collection_a1","collection_a2","collection_a3","collection_a4","collection_b1","collection_b2"] as const;
type Variant=typeof variants[number];
type Role="a"|"b";
type Check=(condition:unknown,id:string)=>void;
const owner=(variant:Variant):Role=>variant.startsWith("collection_b")?"b":"a";
const equalIds=(actual:string[],expected:string[])=>actual.length===expected.length&&actual.toSorted().every((id,i)=>id===expected.toSorted()[i]);
const assetId=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v].id;
const ids=(run:IntegrationRun,vs:Variant[])=>vs.map(v=>assetId(run,v));
const MEMORY_DATE="2024-11-10T12:00:00.000Z",SEEN_DATE="2026-01-02T12:00:00.000Z";
const savedQuery={isSaved:true,type:"on_this_day"};

async function success(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void|Promise<void>){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},(result,check)=>verify(result.data,check));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
function checkAssets(run:IntegrationRun,data:any[],expected:Variant[],check:Check){
  check(Array.isArray(data)&&equalIds(data.map(a=>a.id),ids(run,expected))&&data.every(a=>{
    const v=expected.find(v=>assetId(run,v)===a.id)!;
    return a.ownerId===run.context.actors[owner(v)].user_id&&a.checksum===syntheticPhoto(run.context.lab.state.id,v).sha1;
  }),"exact_assets");
}
function checkMemory(run:IntegrationRun,data:any,key:Role|"deleted",expected:Variant[],saved:boolean,check:Check){
  const role=key==="deleted"?"a":key,memory=run.state.data.memories[key];
  check(data.id===memory.id&&data.ownerId===run.context.actors[role].user_id&&data.type==="on_this_day"&&data.data.year===2024,"memory_identity");
  check(data.isSaved===saved&&data.memoryAt===(key==="a"?MEMORY_DATE:FIXTURE_DATE)&&
    (key!=="a"||data.seenAt===SEEN_DATE),"memory_state");
  checkAssets(run,data.assets,expected,check);
}
async function memory(run:IntegrationRun,id:string,role:Role,key:Role|"deleted",expected:Variant[],saved=true){
  return success(run,id,role,{operation_id:"getMemory",path:{id:run.state.data.memories[key].id}},200,false,
    ["memory_identity","memory_state","exact_assets"],(data,check)=>checkMemory(run,data,key,expected,saved,check));
}
async function statistics(run:IntegrationRun,id:string,role:Role,delta?:number){
  return success(run,id,role,{operation_id:"memoriesStatistics",query:savedQuery},200,false,["saved_total"],(data,check)=>{
    check(Number.isSafeInteger(data.total)&&data.total>=0&&(delta===undefined||data.total===run.state.data.baseline[role]+delta),"saved_total");
  });
}
function checkStack(run:IntegrationRun,data:any,id:string,primary:Variant,expected:Variant[],check:Check){
  check(data.id===id&&data.primaryAssetId===assetId(run,primary)&&data.assets?.[0]?.id===assetId(run,primary),"stack_identity");
  checkAssets(run,data.assets,expected,check);
}
async function stack(run:IntegrationRun,id:string,role:Role,stackId:string,primary:Variant,expected:Variant[]){
  return success(run,id,role,{operation_id:"getStack",path:{id:stackId}},200,false,
    ["stack_identity","exact_assets"],(data,check)=>checkStack(run,data,stackId,primary,expected,check));
}
async function createStack(run:IntegrationRun,id:string,role:Role,expected:Variant[]){
  return success(run,id,role,{operation_id:"createStack",body:{assetIds:ids(run,expected)}},201,true,
    ["stack_identity","exact_assets"],(data,check)=>checkStack(run,data,data.id,expected[0]!,expected,check));
}
async function asset(run:IntegrationRun,id:string,actor:FixtureRole,v:Variant,expectedStack:string|null){
  return success(run,id,actor,{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,["asset_identity","metadata_ready","stack_membership"],(data,check)=>{
    const photo=syntheticPhoto(run.context.lab.state.id,v);
    check(data.id===assetId(run,v)&&data.ownerId===run.context.actors[owner(v)].user_id&&data.checksum===photo.sha1&&data.originalFileName===photo.filename,"asset_identity");
    check(!!data.exifInfo,"metadata_ready");
    check(expectedStack===null?!data.stack:data.stack?.id===expectedStack,"stack_membership");
  });
}
async function upload(run:IntegrationRun){
  for(const v of variants){
    const role=owner(v),p=run.context.actors[role].principal,photo=syntheticPhoto(run.context.lab.state.id,v);
    const file=await run.staging.ingest(p,photo.filename,photo.mime,(async function*(){yield photo.bytes;})(),photo.bytes.length,undefined,photo.sha256);
    const result=await success(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:photo.filename,fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,isFavorite:false,visibility:"timeline"}},201,true,["new_upload"],
      (data,check)=>check(data.status==="created"&&typeof data.id==="string","new_upload"));
    run.state.data.assets[v]={id:result.data.id};run.save();
  }
  // Stack queries inner-join EXIF rows. Wait for metadata without repeating uploads.
  // The maximum 120 polls leaves the entire plan below the shared 256-case bound.
  for(const v of variants){
    let ready=false;
    for(let attempt=0;attempt<20;attempt++){
      await success(run,"metadata_"+v+"_"+attempt,owner(v),{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,["known_asset"],(data,check)=>{
        check(data.id===assetId(run,v)&&data.ownerId===run.context.actors[owner(v)].user_id&&data.checksum===syntheticPhoto(run.context.lab.state.id,v).sha1,"known_asset");
        ready=!!data.exifInfo;
      });
      if(ready)break;
      if(attempt<19)await delay(1000);
    }
    if(!ready)integrationFailure("fixture_metadata_timeout","Synthetic image metadata did not become ready; uploads are never replayed");
  }
}
async function seedMemories(run:IntegrationRun){
  const d=run.state.data;
  for(const role of ["a","b"] as const){const result=await statistics(run,"memory_baseline_"+role,role);d.baseline[role]=result.data.total;run.save();}
  for(const role of ["a","b"] as const){
    const expected:Variant[]=role==="a"?["collection_a1"]:["collection_b1"],requested:Variant[]=role==="a"?["collection_a1","collection_b1"]:expected;
    const result=await success(run,"create_memory_"+role,role,{operation_id:"createMemory",body:{type:"on_this_day",data:{year:2024},memoryAt:FIXTURE_DATE,
      isSaved:role==="b",assetIds:ids(run,requested),showAt:"2026-01-01T00:00:00.000Z",hideAt:"2099-12-31T23:59:59.000Z"}},201,true,
      ["memory_identity","exact_assets"],(data,check)=>{check(typeof data.id==="string"&&data.ownerId===run.context.actors[role].user_id&&data.isSaved===(role==="b"),"memory_identity");checkAssets(run,data.assets,expected,check);});
    d.memories[role]={id:result.data.id};run.save();
  }
  const memoryA=d.memories.a.id,a1=assetId(run,"collection_a1"),a2=assetId(run,"collection_a2"),b1=assetId(run,"collection_b1");
  await success(run,"memory_add_mixed","a",{operation_id:"addMemoryAssets",path:{id:memoryA},body:{ids:[a2,a1,b1]}},200,true,["per_item_add"],(data,check)=>{
    check(Array.isArray(data)&&data.length===3&&data[0].id===a2&&data[0].success===true&&!data[0].error&&
      data[1].id===a1&&data[1].success===false&&data[1].error==="duplicate"&&data[2].id===b1&&data[2].success===false&&data[2].error==="no_permission","per_item_add");
  });
  await success(run,"memory_added_readback","a",{operation_id:"getMemory",path:{id:memoryA}},200,false,["exact_assets"],(data,check)=>checkAssets(run,data.assets,["collection_a1","collection_a2"],check));
  await success(run,"memory_remove_mixed","a",{operation_id:"removeMemoryAssets",path:{id:memoryA},body:{ids:[a2,a2,b1]}},200,true,["per_item_remove"],(data,check)=>{
    check(Array.isArray(data)&&data.length===3&&data[0].id===a2&&data[0].success===true&&!data[0].error&&
      data[1].id===a2&&data[1].success===false&&data[1].error==="not_found"&&data[2].id===b1&&data[2].success===false&&data[2].error==="not_found","per_item_remove");
  });
  await success(run,"update_memory_a","a",{operation_id:"updateMemory",path:{id:memoryA},body:{isSaved:true,memoryAt:MEMORY_DATE,seenAt:SEEN_DATE}},200,true,
    ["memory_identity","memory_state","exact_assets"],(data,check)=>checkMemory(run,data,"a",["collection_a1"],true,check));
  await memory(run,"memory_updated_readback","a","a",["collection_a1"]);
  const created=await success(run,"create_deleted_memory","a",{operation_id:"createMemory",body:{type:"on_this_day",data:{year:2024},memoryAt:FIXTURE_DATE,
    isSaved:true,assetIds:[a1]}},201,true,["new_memory"],(data,check)=>check(typeof data.id==="string"&&data.ownerId===run.context.actors.a.user_id&&data.assets.length===1&&data.assets[0].id===a1,"new_memory"));
  d.memories.deleted={id:created.data.id};run.save();
  await success(run,"empty_memory","a",{operation_id:"removeMemoryAssets",path:{id:created.data.id},body:{ids:[a1]}},200,true,
    ["removed"],(data,check)=>check(data.length===1&&data[0].id===a1&&data[0].success===true,"removed"));
  await memory(run,"empty_memory_readback","a","deleted",[]);
  await success(run,"empty_memory_search_excluded","a",{operation_id:"searchMemories",query:{id:created.data.id}},200,false,
    ["empty_search"],(data,check)=>check(Array.isArray(data)&&data.length===0,"empty_search"));
  // Statistics count the matching memory rows, including a memory with no assets.
  await statistics(run,"saved_statistics_before_delete","a",2);
  await success(run,"delete_memory","a",{operation_id:"deleteMemory",path:{id:created.data.id}},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  await statistics(run,"saved_statistics_after_delete","a",1);
  const foreignCalls:ApiCall[]=[
    {operation_id:"updateMemory",path:{id:memoryA},body:{isSaved:false}},
    {operation_id:"deleteMemory",path:{id:memoryA}},
    {operation_id:"addMemoryAssets",path:{id:memoryA},body:{ids:[b1]}},
    {operation_id:"removeMemoryAssets",path:{id:memoryA},body:{ids:[a1]}}
  ];
  for(const call of foreignCalls)await refused(run,"foreign_"+call.operation_id.toLowerCase(),"b",call,400,true);
  const restricted:ApiCall[]=[
    {operation_id:"createMemory",body:{type:"on_this_day",data:{year:2024},memoryAt:FIXTURE_DATE,assetIds:[a1]}},
    {operation_id:"updateMemory",path:{id:memoryA},body:{isSaved:false}},
    {operation_id:"deleteMemory",path:{id:memoryA}},
    {operation_id:"addMemoryAssets",path:{id:memoryA},body:{ids:[a2]}},
    {operation_id:"removeMemoryAssets",path:{id:memoryA},body:{ids:[a1]}}
  ];
  for(const call of restricted)await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,true);
}
async function seedStacks(run:IntegrationRun){
  const d=run.state.data,a1=assetId(run,"collection_a1"),a2=assetId(run,"collection_a2"),a3=assetId(run,"collection_a3"),a4=assetId(run,"collection_a4"),b1=assetId(run,"collection_b1");
  await refused(run,"foreign_stack_create","b",{operation_id:"createStack",body:{assetIds:[b1,a4]}},400,true);
  const initial=await createStack(run,"create_initial_stack","a",["collection_a1","collection_a2"]);d.stacks.initial=initial.data.id;run.save();
  const b=await createStack(run,"create_b_stack","b",["collection_b1","collection_b2"]);d.stacks.b=b.data.id;run.save();
  const merged=await success(run,"merge_stack","a",{operation_id:"createStack",body:{assetIds:[a1,a3]}},201,true,["stack_identity","exact_assets"],
    (data,check)=>checkStack(run,data,data.id,"collection_a1",["collection_a1","collection_a2","collection_a3"],check));
  d.stacks.merged=merged.data.id;run.save();
  await refused(run,"merged_old_stack_removed","a",{operation_id:"getStack",path:{id:initial.data.id}},400);
  await refused(run,"stack_invalid_primary","a",{operation_id:"updateStack",path:{id:merged.data.id},body:{primaryAssetId:a4}},400,true);
  await refused(run,"stack_remove_primary","a",{operation_id:"removeAssetFromStack",path:{id:merged.data.id,assetId:a1}},400,true);
  await refused(run,"stack_remove_nonmember","a",{operation_id:"removeAssetFromStack",path:{id:merged.data.id,assetId:a4}},400,true);
  await stack(run,"stack_after_rejected_changes","a",merged.data.id,"collection_a1",["collection_a1","collection_a2","collection_a3"]);
  await success(run,"stack_remove_child","a",{operation_id:"removeAssetFromStack",path:{id:merged.data.id,assetId:a2}},204,true,["remove_ack"],(_data,check)=>check(true,"remove_ack"));
  await stack(run,"stack_removed_readback","a",merged.data.id,"collection_a1",["collection_a1","collection_a3"]);
  await asset(run,"stack_detached_asset","a","collection_a2",null);
  await success(run,"stack_change_primary","a",{operation_id:"updateStack",path:{id:merged.data.id},body:{primaryAssetId:a3}},200,true,
    ["stack_identity","exact_assets"],(data,check)=>checkStack(run,data,merged.data.id,"collection_a3",["collection_a1","collection_a3"],check));
  await stack(run,"stack_primary_readback","a",merged.data.id,"collection_a3",["collection_a1","collection_a3"]);
  await success(run,"delete_single_stack","a",{operation_id:"deleteStack",path:{id:merged.data.id}},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  for(const v of ["collection_a1","collection_a3"] as const)await asset(run,"single_delete_detached_"+v,"a",v,null);
  const first=await createStack(run,"create_bulk_stack_one","a",["collection_a1","collection_a2"]),second=await createStack(run,"create_bulk_stack_two","a",["collection_a3","collection_a4"]);
  d.stacks.bulk=[first.data.id,second.data.id];run.save();
  await refused(run,"bulk_delete_mixed_owners","a",{operation_id:"deleteStacks",body:{ids:[first.data.id,b.data.id]}},400,true);
  await stack(run,"bulk_refusal_preserves_a","a",first.data.id,"collection_a1",["collection_a1","collection_a2"]);
  await stack(run,"bulk_refusal_preserves_b","b",b.data.id,"collection_b1",["collection_b1","collection_b2"]);
  await success(run,"delete_bulk_stacks","a",{operation_id:"deleteStacks",body:{ids:d.stacks.bulk}},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  for(let i=0;i<d.stacks.bulk.length;i++)await refused(run,"bulk_deleted_readback_"+i,"a",{operation_id:"getStack",path:{id:d.stacks.bulk[i]}},400);
  const final=await createStack(run,"create_final_a_stack","a",["collection_a1","collection_a2","collection_a3"]);d.stacks.a=final.data.id;run.save();
  const foreign:ApiCall[]=[
    {operation_id:"updateStack",path:{id:d.stacks.a},body:{primaryAssetId:a2}},
    {operation_id:"deleteStack",path:{id:d.stacks.a}},
    {operation_id:"deleteStacks",body:{ids:[d.stacks.a]}},
    {operation_id:"removeAssetFromStack",path:{id:d.stacks.a,assetId:a2}}
  ];
  for(const call of foreign)await refused(run,"foreign_"+call.operation_id.toLowerCase(),"b",call,400,true);
  const restricted:ApiCall[]=[
    {operation_id:"createStack",body:{assetIds:[a1,a4]}},
    {operation_id:"updateStack",path:{id:d.stacks.a},body:{primaryAssetId:a2}},
    {operation_id:"deleteStack",path:{id:d.stacks.a}},
    {operation_id:"deleteStacks",body:{ids:[d.stacks.a]}},
    {operation_id:"removeAssetFromStack",path:{id:d.stacks.a,assetId:a2}}
  ];
  for(const call of restricted)await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,true);
}
async function verifyCollections(run:IntegrationRun){
  const d=run.state.data;
  for(const role of ["a","b"] as const){
    const other=role==="a"?"b":"a",expected:Variant[]=role==="a"?["collection_a1"]:["collection_b1"];
    await memory(run,"final_memory_"+role,role,role,expected);
    await success(run,"final_memory_search_"+role,role,{operation_id:"searchMemories",query:{...savedQuery,id:d.memories[role].id,size:1,page:1,order:"asc",for:"2026-01-02"}},200,false,
      ["one_memory","memory_identity","memory_state","exact_assets"],(data,check)=>{check(Array.isArray(data)&&data.length===1,"one_memory");checkMemory(run,data[0],role,expected,true,check);});
    await success(run,"final_foreign_memory_search_"+role,role,{operation_id:"searchMemories",query:{id:d.memories[other].id}},200,false,
      ["isolated_search"],(data,check)=>check(Array.isArray(data)&&data.length===0,"isolated_search"));
    await success(run,"final_memory_page_two_"+role,role,{operation_id:"searchMemories",query:{id:d.memories[role].id,size:1,page:2}},200,false,
      ["empty_page"],(data,check)=>check(Array.isArray(data)&&data.length===0,"empty_page"));
    await statistics(run,"final_memory_statistics_"+role,role,1);
    await refused(run,"final_foreign_memory_"+role,role,{operation_id:"getMemory",path:{id:d.memories[other].id}},400);
    const members:Variant[]=role==="a"?["collection_a1","collection_a2","collection_a3"]:["collection_b1","collection_b2"],primary=members[0]!;
    await stack(run,"final_stack_"+role,role,d.stacks[role],primary,members);
    await success(run,"final_stack_search_"+role,role,{operation_id:"searchStacks",query:{primaryAssetId:assetId(run,primary)}},200,false,
      ["one_stack","stack_identity","exact_assets"],(data,check)=>{check(Array.isArray(data)&&data.length===1,"one_stack");checkStack(run,data[0],d.stacks[role],primary,members,check);});
    const foreignPrimary:Variant=role==="a"?"collection_b1":"collection_a1";
    await success(run,"final_foreign_stack_search_"+role,role,{operation_id:"searchStacks",query:{primaryAssetId:assetId(run,foreignPrimary)}},200,false,
      ["isolated_search"],(data,check)=>check(Array.isArray(data)&&data.length===0,"isolated_search"));
    await refused(run,"final_foreign_stack_"+role,role,{operation_id:"getStack",path:{id:d.stacks[other]}},400);
  }
  await refused(run,"final_deleted_memory","a",{operation_id:"getMemory",path:{id:d.memories.deleted.id}},400);
  for(const [i,id] of [d.stacks.initial,d.stacks.merged,...d.stacks.bulk].entries())await refused(run,"final_deleted_stack_"+i,"a",{operation_id:"getStack",path:{id}},400);
  for(const call of [
    {operation_id:"getMemory",path:{id:d.memories.a.id}},{operation_id:"searchMemories",query:{id:d.memories.a.id}},{operation_id:"memoriesStatistics",query:savedQuery},
    {operation_id:"getStack",path:{id:d.stacks.a}},{operation_id:"searchStacks",query:{primaryAssetId:assetId(run,"collection_a1")}}
  ] as ApiCall[])await refused(run,"final_restricted_"+call.operation_id.toLowerCase(),"restricted",call,403);
  for(const v of variants)await asset(run,"final_asset_"+v,owner(v),v,v==="collection_a4"?null:d.stacks[owner(v)]);
  await asset(run,"final_restricted_asset","restricted","collection_a1",d.stacks.a);
}
export async function createCollectionFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,COLLECTION_PLAN);
    try{
      if(!run.revalidate){run.state.data={assets:{},memories:{},stacks:{},baseline:{}};run.save();await upload(run);await seedMemories(run);await seedStacks(run);}
      await verifyCollections(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"collection_fixtures_revalidated":"collection_fixtures_ready",execution_scope:run.state.execution_scope,synthetic_assets:6,retained_memories:2,retained_stacks:2,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Collection completion is committed; retry only read-only revalidation and report publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve the durable sent/completion receipt. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing collections no longer match their assertions; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","Collection setup did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
