import { randomBytes,createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto } from "./integration-media.js";
import { profileImageFrame } from "./integration-profile-image.js";
import { readDecoded } from "./content-encoding.js";
import { registry } from "./registry.js";
import type { ApiCall } from "./types.js";

export const USER_PLAN="user_fixtures_v1";
type Role="a"|"b";type Check=(condition:unknown,id:string)=>void;
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(a,b);
const ids=(rows:any[])=>rows.map(row=>row.id).toSorted();
const identity=(u:any)=>({id:u.id,email:u.email,name:u.name,avatarColor:u.avatarColor,isAdmin:u.isAdmin});
const publicIdentity=(u:any)=>({id:u.id,email:u.email,name:u.name,avatarColor:u.avatarColor});
async function json(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},(result,check)=>verify(result.data,check));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
const dId=(run:IntegrationRun):string=>run.state.data.extra.id;
const extraEmail=(run:IntegrationRun)=>"mcp-user-"+run.context.lab.state.id+"@example.invalid";
function publicConfig(user:any){
  const project=(value:any,schema:any):any=>{
    if(schema.$ref)return project(value,registry.schemas[schema.$ref.split("/").at(-1)!]);
    if(schema.type==="object")return Object.fromEntries(Object.entries<any>(schema.properties).map(([key,child])=>[key,project(value[key],child)]));
    return structuredClone(value);
  };
  return project(user,registry.schemas.PublicConfigDto);
}
async function preflight(run:IntegrationRun){
  const d=run.state.data;d.baseline={users:{},preferences:{},onboarding:{}};d.extra={};d.profiles={};run.save();
  for(const role of ["a","b"] as const){
    const who=await json(run,"baseline_user_"+role,role,{operation_id:"getMyUser"},200,false,["owned_empty_profile"],(data,check)=>
      check(data.id===run.context.actors[role].user_id&&data.profileImagePath===""&&data.license===null,"owned_empty_profile"));
    d.baseline.users[role]=who.data;
    const pref=await json(run,"baseline_preferences_"+role,role,{operation_id:"getMyPreferences"},200,false,["resolved_preferences"],(data,check)=>
      check(typeof data.ratings.enabled==="boolean"&&Number.isSafeInteger(data.download.archiveSize),"resolved_preferences"));
    d.baseline.preferences[role]=pref.data;
    const onboard=await json(run,"baseline_onboarding_"+role,role,{operation_id:"getUserOnboarding"},200,false,["onboarding_boolean"],(data,check)=>
      check(typeof data.isOnboarded==="boolean","onboarding_boolean"));
    d.baseline.onboarding[role]=onboard.data;run.save();
  }
  const all=await json(run,"baseline_admin_users","admin",{operation_id:"searchUsersAdmin",query:{withDeleted:true}},200,false,["unused_extra_email"],(data,check)=>
    check(Array.isArray(data)&&!data.some((u:any)=>u.email===extraEmail(run)),"unused_extra_email"));
  d.baseline.admin_all_ids=ids(all.data);d.baseline.active_ids=ids(all.data.filter((u:any)=>u.deletedAt===null));run.save();
  for(const [key,operation_id] of [["user_config","getUserConfig"],["user_defaults","getUserConfigDefaults"]] as const){
    const r=await json(run,"baseline_"+key,"a",{operation_id},200,false,["user_configuration"],(data,check)=>check(typeof data.server.publicUsers==="boolean"&&data.user.deleteDelay>=1,"user_configuration"));
    d.baseline[key]=r.data;run.save();
  }
}
async function profileBytes(run:IntegrationRun,id:string,actor:FixtureRole,target:Role,record=false){
  const expected=run.state.data.profiles[target];
  return run.execute({id,actor,call:{operation_id:"getProfileImage",path:{id:run.context.actors[target].user_id}},status:200,mutates:false,kind:"success",
    assertions:["profile_frame","stable_profile_bytes"]},async(result,check)=>{
    const principal=run.context.actors[actor].principal,stored=run.context.vault.get(principal,result.result_ref,"result");
    const bytes=await readDecoded(run.context.vault.rawStream(principal,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024);
    const mime=result.upstream.content_type,frame=profileImageFrame(bytes,mime),sha256=createHash("sha256").update(bytes).digest("hex");
    check(frame.width===64&&frame.height===32&&expected.path.endsWith("."+frame.format)&&mime==="image/"+frame.format,"profile_frame");
    check(record?!expected.sha256:sha256===expected.sha256,"stable_profile_bytes");
    if(record){expected.sha256=sha256;expected.mime=mime;run.save();}
  });
}
async function profileUpload(run:IntegrationRun,id:string,actor:Role,variant:"profile_a_first"|"profile_a_final"|"profile_b"){
  const p=syntheticPhoto(run.context.lab.state.id,variant),principal=run.context.actors[actor].principal;
  const file=await run.staging.ingest(principal,p.filename,p.mime,(async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
  const previous=run.state.data.profiles[actor]?.path;
  const r=await json(run,id,actor,{operation_id:"createProfileImage",content_type:"multipart/form-data",files:{file:{file_ref:file.file_ref}}},201,true,
    ["profile_owner","new_profile_path"],(data,check)=>{
      check(data.userId===run.context.actors[actor].user_id,"profile_owner");
      check(typeof data.profileImagePath==="string"&&/\.(jpeg|webp)$/.test(data.profileImagePath)&&data.profileImagePath!==previous&&typeof data.profileChangedAt==="string","new_profile_path");
    });
  run.state.data.profiles[actor]={path:r.data.profileImagePath,changed_at:r.data.profileChangedAt};run.save();
}
async function profiles(run:IntegrationRun){
  await profileUpload(run,"create_profile_a","a","profile_a_first");
  await profileBytes(run,"first_profile_a_owner","a","a",true);await profileBytes(run,"first_profile_a_reader","b","a");
  const first=run.state.data.profiles.a.sha256;run.state.data.first_profile_sha256=first;run.save();
  await profileUpload(run,"replace_created_profile_a","a","profile_a_final");await profileBytes(run,"replacement_profile_a","a","a",true);
  if(run.state.data.profiles.a.sha256===first)integrationFailure("fixture_assertion","A replacement profile retained the previous image bytes");
  await profileUpload(run,"create_profile_b","b","profile_b");await profileBytes(run,"profile_b_before_delete","a","b",true);
  if(run.state.data.profiles.a.sha256===run.state.data.profiles.b.sha256)integrationFailure("fixture_assertion","Distinct synthetic profiles returned the same bytes");
  await json(run,"delete_created_profile_b","b",{operation_id:"deleteProfileImage"},204,true,["delete_ack"],(_d,check)=>check(true,"delete_ack"));
  await refused(run,"delete_missing_profile_b","b",{operation_id:"deleteProfileImage"},400,true);
  const p=syntheticPhoto(run.context.lab.state.id,"profile_b"),principal=run.context.actors.restricted.principal;
  const file=await run.staging.ingest(principal,p.filename,p.mime,(async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
  await refused(run,"restricted_create_profile","restricted",{operation_id:"createProfileImage",content_type:"multipart/form-data",files:{file:{file_ref:file.file_ref}}},403,true);
  await refused(run,"restricted_delete_profile","restricted",{operation_id:"deleteProfileImage"},403,true);
}
async function preferences(run:IntegrationRun){
  const base=run.state.data.baseline.preferences.a,expected=structuredClone(base);expected.ratings.enabled=!base.ratings.enabled;
  await json(run,"change_rating_preference","a",{operation_id:"updateMyPreferences",body:{ratings:{enabled:expected.ratings.enabled}}},200,true,
    ["merged_preferences"],(data,check)=>check(same(data,expected),"merged_preferences"));
  await json(run,"rating_preference_readback","a",{operation_id:"getMyPreferences"},200,false,["persisted_preferences"],(data,check)=>check(same(data,expected),"persisted_preferences"));
  expected.download.archiveSize=base.download.archiveSize===2147483647?2147483646:2147483647;
  await json(run,"change_download_leaf","a",{operation_id:"updateMyPreferences",body:{download:{archiveSize:expected.download.archiveSize}}},200,true,
    ["sibling_preservation"],(data,check)=>check(same(data,expected),"sibling_preservation"));
  await json(run,"download_preference_readback","a",{operation_id:"getMyPreferences"},200,false,["persisted_preferences"],(data,check)=>check(same(data,expected),"persisted_preferences"));
  await json(run,"restore_changed_preferences","a",{operation_id:"updateMyPreferences",body:{ratings:{enabled:base.ratings.enabled},download:{archiveSize:base.download.archiveSize}}},200,true,
    ["restored_preferences"],(data,check)=>check(same(data,base),"restored_preferences"));
  await refused(run,"restricted_update_preferences","restricted",{operation_id:"updateMyPreferences",body:{ratings:{enabled:!base.ratings.enabled}}},403,true);
}
async function namesOnboarding(run:IntegrationRun){
  const d=run.state.data,base=d.baseline.users.a,name="MCP updated "+run.context.lab.state.id;
  await json(run,"update_caller_name","a",{operation_id:"updateMyUser",body:{name}},200,true,["caller_updated"],(data,check)=>
    check(same(identity(data),{...identity(base),name}),"caller_updated"));
  await json(run,"caller_name_readback","b",{operation_id:"getUser",path:{id:base.id}},200,false,["public_user_name"],(data,check)=>
    check(same(publicIdentity(data),{...publicIdentity(base),name}),"public_user_name"));
  await json(run,"restore_caller_name","a",{operation_id:"updateMyUser",body:{name:base.name}},200,true,["caller_restored"],(data,check)=>
    check(same(identity(data),identity(base)),"caller_restored"));
  await refused(run,"restricted_update_name","restricted",{operation_id:"updateMyUser",body:{name}},403,true);
  const onboarding=d.baseline.onboarding.a.isOnboarded;
  await json(run,"set_changed_onboarding","a",{operation_id:"setUserOnboarding",body:{isOnboarded:!onboarding}},200,true,["changed_onboarding"],(data,check)=>check(data.isOnboarded===!onboarding,"changed_onboarding"));
  await json(run,"changed_onboarding_readback","a",{operation_id:"getUserOnboarding"},200,false,["persisted_onboarding"],(data,check)=>check(data.isOnboarded===!onboarding,"persisted_onboarding"));
  await json(run,"delete_onboarding_metadata","a",{operation_id:"deleteUserOnboarding"},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  await json(run,"deleted_onboarding_readback","a",{operation_id:"getUserOnboarding"},200,false,["default_onboarding"],(data,check)=>check(data.isOnboarded===false,"default_onboarding"));
  if(onboarding)await json(run,"restore_original_onboarding","a",{operation_id:"setUserOnboarding",body:{isOnboarded:true}},200,true,["restored_onboarding"],(data,check)=>check(data.isOnboarded===true,"restored_onboarding"));
  for(const operation_id of ["setUserOnboarding","deleteUserOnboarding"])
    await refused(run,"restricted_"+operation_id.toLowerCase(),"restricted",{operation_id,...(operation_id==="setUserOnboarding"?{body:{isOnboarded:true}}:{})},403,true);
  await refused(run,"missing_user_license","a",{operation_id:"getUserLicense"},404);
  await json(run,"delete_absent_license","a",{operation_id:"deleteUserLicense"},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  await refused(run,"restricted_delete_license","restricted",{operation_id:"deleteUserLicense"},403,true);
}
const heatQuery={from:"2026-01-01",to:"2026-01-03",type:"Upload"};
function validHeatmap(data:any,zero=false){
  return data.from===heatQuery.from&&data.to===heatQuery.to&&same(data.series.map((x:any)=>x.date),["2026-01-01","2026-01-02","2026-01-03"])&&
    data.totalCount===data.series.reduce((sum:number,x:any)=>sum+x.count,0)&&(!zero||data.totalCount===0&&data.series.every((x:any)=>x.count===0));
}
function createExtraCall(run:IntegrationRun,actor:FixtureRole):ApiCall{
  return run.protect(actor,{operation_id:"createUserAdmin",body:{email:extraEmail(run),name:"MCP extra "+run.context.lab.state.id,
    isAdmin:false,notify:false,shouldChangePassword:false}}, {"/password":"It!"+randomBytes(30).toString("base64url")+"a1"});
}
async function adminUsers(run:IntegrationRun){
  const d=run.state.data,r=await json(run,"create_extra_user","admin",createExtraCall(run,"admin"),201,true,["created_extra_user"],(data,check)=>
    check(data.email===extraEmail(run)&&data.isAdmin===false&&data.status==="active"&&data.deletedAt===null&&data.profileImagePath===""&&data.shouldChangePassword===false,"created_extra_user"));
  d.extra=identity(r.data);run.save();const id=dId(run);
  await refused(run,"duplicate_extra_email","admin",createExtraCall(run,"admin"),400,true);
  const changed={name:"MCP managed "+run.context.lab.state.id,avatarColor:"pink",storageLabel:"mcp-"+run.context.lab.state.id,quotaSizeInBytes:1048576,shouldChangePassword:true};
  await json(run,"update_extra_user","admin",{operation_id:"updateUserAdmin",path:{id},body:changed},200,true,["admin_update"],(data,check)=>
    check(data.id===id&&Object.entries(changed).every(([k,v])=>same(data[k],v)),"admin_update"));
  d.extra={...d.extra,...changed};run.save();
  await json(run,"extra_update_readback","admin",{operation_id:"getUserAdmin",path:{id}},200,false,["persisted_admin_update"],(data,check)=>
    check(Object.entries(d.extra).every(([k,v])=>same(data[k],v))&&data.status==="active","persisted_admin_update"));
  const prefs=await json(run,"extra_preferences_baseline","admin",{operation_id:"getUserPreferencesAdmin",path:{id}},200,false,["default_preferences"],(data,check)=>
    check(data.ratings.enabled===false&&data.download.includeEmbeddedVideos===false,"default_preferences"));
  const expected=structuredClone(prefs.data);expected.ratings.enabled=true;expected.download.includeEmbeddedVideos=true;d.extra_preferences=expected;run.save();
  await json(run,"update_extra_preferences","admin",{operation_id:"updateUserPreferencesAdmin",path:{id},body:{ratings:{enabled:true},download:{includeEmbeddedVideos:true}}},200,true,
    ["merged_admin_preferences"],(data,check)=>check(same(data,expected),"merged_admin_preferences"));
  await json(run,"extra_preferences_readback","admin",{operation_id:"getUserPreferencesAdmin",path:{id}},200,false,["persisted_admin_preferences"],(data,check)=>check(same(data,expected),"persisted_admin_preferences"));
  for(const isAdmin of [true,false]){
    await json(run,"extra_admin_flag_"+isAdmin,"admin",{operation_id:"updateUserAdmin",path:{id},body:{isAdmin}},200,true,
      ["admin_flag"],(data,check)=>check(data.id===id&&data.isAdmin===isAdmin,"admin_flag"));
    await json(run,"extra_admin_flag_readback_"+isAdmin,"admin",{operation_id:"getUserAdmin",path:{id}},200,false,
      ["persisted_admin_flag"],(data,check)=>check(data.id===id&&data.isAdmin===isAdmin,"persisted_admin_flag"));
  }
  await refused(run,"admin_cannot_demote_self","admin",{operation_id:"updateUserAdmin",path:{id:run.context.actors.admin.user_id},body:{isAdmin:false}},400,true);
  await refused(run,"admin_cannot_delete_self","admin",{operation_id:"deleteUserAdmin",path:{id:run.context.actors.admin.user_id},body:{force:false}},403,true);
  await json(run,"soft_delete_extra_user","admin",{operation_id:"deleteUserAdmin",path:{id},body:{force:false}},200,true,["soft_deleted"],(data,check)=>
    check(data.id===id&&data.status==="deleted"&&typeof data.deletedAt==="string","soft_deleted"));
  await json(run,"soft_delete_readback","admin",{operation_id:"getUserAdmin",path:{id}},200,false,["persisted_soft_delete"],(data,check)=>
    check(data.id===id&&data.status==="deleted"&&typeof data.deletedAt==="string","persisted_soft_delete"));
  await refused(run,"soft_deleted_user_hidden","a",{operation_id:"getUser",path:{id}},404);
  for(const withDeleted of [false,true])await json(run,"deleted_search_"+withDeleted,"admin",{operation_id:"searchUsersAdmin",query:{id,withDeleted}},200,false,
    ["deleted_filter"],(data,check)=>check(same(ids(data),withDeleted?[id]:[]),"deleted_filter"));
  await json(run,"restore_extra_user","admin",{operation_id:"restoreUserAdmin",path:{id}},200,true,["restored_user"],(data,check)=>
    check(data.id===id&&data.status==="active"&&data.deletedAt===null,"restored_user"));
  await json(run,"restore_extra_readback","admin",{operation_id:"getUserAdmin",path:{id}},200,false,["persisted_restore"],(data,check)=>check(data.id===id&&data.status==="active"&&data.deletedAt===null,"persisted_restore"));
  await json(run,"clear_extra_storage_label","admin",{operation_id:"updateUserAdmin",path:{id},body:{storageLabel:""}},200,true,["cleared_storage_label"],(data,check)=>
    check(data.id===id&&data.storageLabel===null,"cleared_storage_label"));
  d.extra.storageLabel=null;run.save();
  const calls:ApiCall[]=[
    {operation_id:"searchUsersAdmin"},{operation_id:"getUserAdmin",path:{id}},{operation_id:"getUserPreferencesAdmin",path:{id}},
    {operation_id:"getUserSessionsAdmin",path:{id}},{operation_id:"getUserStatisticsAdmin",path:{id}},
    {operation_id:"getUserCalendarHeatmapAdmin",path:{id},query:heatQuery},{operation_id:"updateUserAdmin",path:{id},body:{name:"refused"}},
    {operation_id:"updateUserPreferencesAdmin",path:{id},body:{ratings:{enabled:false}}},
    {operation_id:"deleteUserAdmin",path:{id},body:{force:false}},{operation_id:"restoreUserAdmin",path:{id}}
  ];
  for(const actor of ["a","restricted"] as const){
    await refused(run,actor+"_create_admin_user",actor,createExtraCall(run,actor),403,true);
    for(const call of calls)await refused(run,actor+"_"+call.operation_id.toLowerCase(),actor,call,403,!call.operation_id.startsWith("get")&&!call.operation_id.startsWith("search"));
  }
}
async function verifyUsers(run:IntegrationRun){
  const d=run.state.data,id=dId(run),expectedIds=[...d.baseline.active_ids,id].toSorted();
  for(const role of ["a","b"] as const){
    await json(run,"final_user_"+role,role,{operation_id:"getMyUser"},200,false,["caller_identity","profile_state"],(data,check)=>{
      check(same(identity(data),identity(d.baseline.users[role])),"caller_identity");
      check(data.profileImagePath===(role==="a"?d.profiles.a.path:"")&&(role!=="a"||data.profileChangedAt===d.profiles.a.changed_at),"profile_state");
    });
    await json(run,"final_preferences_"+role,role,{operation_id:"getMyPreferences"},200,false,["original_preferences"],(data,check)=>
      check(same(data,d.baseline.preferences[role]),"original_preferences"));
    await json(run,"final_onboarding_"+role,role,{operation_id:"getUserOnboarding"},200,false,["original_onboarding"],(data,check)=>
      check(same(data,d.baseline.onboarding[role]),"original_onboarding"));
    await profileBytes(run,"final_profile_a_"+role,role,"a");
    await refused(run,"final_missing_profile_b_"+role,role,{operation_id:"getProfileImage",path:{id:run.context.actors.b.user_id}},404);
    await json(run,"final_public_extra_"+role,role,{operation_id:"getUser",path:{id}},200,false,["public_extra_identity"],(data,check)=>
      check(same(publicIdentity(data),publicIdentity(d.extra)),"public_extra_identity"));
    await json(run,"final_user_search_"+role,role,{operation_id:"searchUsers"},200,false,["user_search_visibility"],(data,check)=>
      check(same(ids(data),d.baseline.user_config.server.publicUsers?expectedIds:[run.context.actors[role].user_id]),"user_search_visibility"));
  }
  await json(run,"final_extra_user","admin",{operation_id:"getUserAdmin",path:{id}},200,false,["extra_identity"],(data,check)=>
    check(Object.entries(d.extra).every(([k,v])=>same(data[k],v))&&data.status==="active"&&data.deletedAt===null,"extra_identity"));
  await json(run,"final_extra_preferences","admin",{operation_id:"getUserPreferencesAdmin",path:{id}},200,false,["extra_preferences"],(data,check)=>
    check(same(data,d.extra_preferences),"extra_preferences"));
  await json(run,"final_extra_sessions","admin",{operation_id:"getUserSessionsAdmin",path:{id}},200,false,["no_extra_sessions"],(data,check)=>check(same(data,[]),"no_extra_sessions"));
  await json(run,"final_extra_statistics","admin",{operation_id:"getUserStatisticsAdmin",path:{id}},200,false,["no_extra_assets"],(data,check)=>
    check(same(data,{images:0,videos:0,total:0}),"no_extra_assets"));
  await json(run,"final_extra_heatmap","admin",{operation_id:"getUserCalendarHeatmapAdmin",path:{id},query:heatQuery},200,false,["zero_utc_heatmap"],(data,check)=>check(validHeatmap(data,true),"zero_utc_heatmap"));
  const own=await json(run,"final_caller_heatmap","a",{operation_id:"getMyCalendarHeatmap",query:heatQuery},200,false,["inclusive_utc_heatmap"],(data,check)=>check(validHeatmap(data),"inclusive_utc_heatmap"));
  await json(run,"final_admin_caller_heatmap","admin",{operation_id:"getUserCalendarHeatmapAdmin",path:{id:run.context.actors.a.user_id},query:heatQuery},200,false,
    ["same_caller_heatmap"],(data,check)=>check(same(data,own.data),"same_caller_heatmap"));
  for(const withDeleted of [false,true])await json(run,"final_admin_search_"+withDeleted,"admin",{operation_id:"searchUsersAdmin",query:{withDeleted}},200,false,
    ["admin_user_membership"],(data,check)=>check(same(ids(data),withDeleted?[...d.baseline.admin_all_ids,id].toSorted():expectedIds),"admin_user_membership"));
  for(const [key,operation_id] of [["user_config","getUserConfig"],["user_defaults","getUserConfigDefaults"]] as const){
    await json(run,"final_"+key,"a",{operation_id},200,false,["unchanged_user_configuration"],(data,check)=>check(same(data,d.baseline[key]),"unchanged_user_configuration"));
    await refused(run,"final_restricted_"+key,"restricted",{operation_id},403);
    const publicOperation=key==="user_config"?"getPublicConfig":"getPublicConfigDefaults";
    for(const role of ["a","b","admin","restricted"] as const)await json(run,"final_public_"+key+"_"+role,role,{operation_id:publicOperation},200,false,
      ["public_visibility_projection"],(data,check)=>check(same(data,publicConfig(d.baseline[key])),"public_visibility_projection"));
  }
  await refused(run,"final_restricted_profile","restricted",{operation_id:"getProfileImage",path:{id:run.context.actors.a.user_id}},403);
  for(const operation_id of ["getMyUser","getUser","searchUsers","getMyPreferences","getUserOnboarding","getMyCalendarHeatmap","getUserLicense"]){
    const call:ApiCall={operation_id,...(operation_id==="getUser"?{path:{id}}:{}),...(operation_id==="getMyCalendarHeatmap"?{query:heatQuery}:{})};
    await refused(run,"final_restricted_"+operation_id.toLowerCase(),"restricted",call,403);
  }
  await refused(run,"final_absent_license","a",{operation_id:"getUserLicense"},404);
}
export async function createUserFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,USER_PLAN);
    try{
      if(!run.revalidate){await preflight(run);await profiles(run);await preferences(run);await namesOnboarding(run);await adminUsers(run);}
      await verifyUsers(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"user_fixtures_revalidated":"user_fixtures_ready",execution_scope:run.state.execution_scope,
        retained_synthetic_profile_images:1,retained_extra_users:1,original_actor_credentials_changed:false,original_preferences_restored:true,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","User completion is committed; repeat only existing reads and report publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve durable receipts. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing user fixtures no longer match their assertions; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","User setup did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
