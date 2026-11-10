import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure,type CaseContext } from "./integration-run.js";
import { ackMap,lastAcks,completeSyncRows } from "./integration-sync-results.js";
import { syntheticPhoto,FIXTURE_DATE } from "./integration-media.js";
import type { ApiCall } from "./types.js";

export const SYNC_PLAN="sync_fixtures_v1";
type Owner="a"|"b";type Session="a"|"a_alt"|"b";
type Check=(condition:unknown,id:string)=>void;
const owner=(session:Session):Owner=>session==="b"?"b":"a";
const selected=(run:IntegrationRun,name:Session):CaseContext=>run.state.data.contexts[name];
const requestTypes=["AuthUsersV2","AssetsV2"];
const stale="SyncCompleteV1|00000000-0000-7000-8000-000000000000";
async function success(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],
  verify:(result:any,check:Check)=>void|Promise<void>,context?:CaseContext){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions,context},verify);
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
async function checkpoint(run:IntegrationRun,id:string,name:Session,expected:Record<string,string>){
  return success(run,id,owner(name),{operation_id:"getSyncAck"},200,false,["exact_session_checkpoints"],(result,check)=>{
    check(isDeepStrictEqual(ackMap(result.data),expected),"exact_session_checkpoints");
  },selected(run,name));
}
async function acknowledge(run:IntegrationRun,id:string,name:Session,values:string[],status=204){
  return run.execute({id,actor:owner(name),call:{operation_id:"sendSyncAck",body:{acks:values}},status,mutates:true,kind:status===204?"success":"refusal",
    assertions:["acknowledgement_status"],context:selected(run,name)},(result,check)=>check(result.upstream.status===status,"acknowledgement_status"));
}
async function sessionIdentity(run:IntegrationRun,id:string,name:Session){
  const role=owner(name),c=selected(run,name),expected=run.state.data.sessions[name];
  await success(run,id,role,{operation_id:"getSessions"},200,false,["one_current_child","session_special_mode","reset_not_pending"],(result,check)=>{
    const current=result.data.filter((value:any)=>value.current);
    check(current.length===1&&current[0].id===expected.id&&current[0].deviceType===expected.device_type,"one_current_child");
    check(run.contexts.describe(run.context.actors[role].principal,c.ref).mode==="special","session_special_mode");
    check(current[0].isPendingSyncReset===false,"reset_not_pending");
  },c);
}
async function connect(run:IntegrationRun){
  for(const role of ["a","b"] as const){
    const p=run.context.actors[role].principal,actor=run.context.vault.get(p,"actor","fixture_actor");
    if(actor.role!==role||actor.owner!==role||actor.user_id!==run.context.actors[role].user_id||typeof actor.session!=="string")
      integrationFailure("fixture_session","Expected the original synthetic owner's session");
    const c=await run.contexts.register(p,{kind:"session",credential:actor.session,acknowledge:true,ttl_seconds:86400});
    if(c.mode!=="special"||c.api_key_permissions_inherited!==false)integrationFailure("fixture_session","Unexpected session mode");
    const context={ref:c.context_ref,generation:c.generation};run.state.data.parents[role]=context;run.save();
    await success(run,"parent_session_"+role,role,{operation_id:"getSessions"},200,false,["one_current_parent"],(result,check)=>{
      const current=result.data.filter((value:any)=>value.current);check(current.length===1&&typeof current[0].id==="string","one_current_parent");
      run.state.data.parent_ids[role]=current[0].id;run.save();
    },context);
  }
  for(const name of ["a","a_alt","b"] as const){
    const role=owner(name),p=run.context.actors[role].principal,parent=run.state.data.parents[role],
      deviceType="MCP sync "+name+" "+run.context.lab.state.id;
    const result=await success(run,"create_child_"+name,role,{operation_id:"createSession",body:{deviceOS:"Synthetic integration",deviceType,duration:86400}},201,true,
      ["child_identity","protected_child_token"],(result,check)=>{
        check(typeof result.data.id==="string"&&result.data.id!==run.state.data.parent_ids[role]&&result.data.deviceType===deviceType&&result.data.current===false,"child_identity");
        check(typeof result.data.token?.secret_ref==="string","protected_child_token");
      },parent);
    const record=run.context.vault.get(p,result.result_ref,"result");run.contexts.assertResult(p,record);
    const token=run.context.vault.get(p,result.data.token.secret_ref,"secret");
    if(token.revision!==record.revision||token.context_ref!==parent.ref||token.context_generation!==parent.generation||typeof token.value!=="string"||!token.value)
      integrationFailure("fixture_session","Child token provenance differs");
    const c=await run.contexts.register(p,{kind:"session",credential:token.value,acknowledge:true,ttl_seconds:86400});
    if(c.mode!=="special"||c.api_key_permissions_inherited!==false)integrationFailure("fixture_session","Child session enabled an unexpected mode");
    run.state.data.contexts[name]={ref:c.context_ref,generation:c.generation};run.state.data.sessions[name]={id:result.data.id,device_type:deviceType};run.save();
    await sessionIdentity(run,"initial_child_"+name,name);
  }
  const ids=Object.values<any>(run.state.data.sessions).map(value=>value.id);
  if(new Set(ids).size!==3||run.state.data.parent_ids.a===run.state.data.parent_ids.b)integrationFailure("fixture_session","Synthetic sessions were not distinct");
}
async function asset(run:IntegrationRun,id:string,role:Owner,favorite:boolean){
  const expected=run.state.data.assets[role],photo=syntheticPhoto(run.context.lab.state.id,role==="a"?"sync_a":"sync_b");
  await success(run,id,role,{operation_id:"getAssetInfo",path:{id:expected.id}},200,false,["fixture_asset"],(result,check)=>{
    const value=result.data;check(value.id===expected.id&&value.ownerId===run.context.actors[role].user_id&&value.checksum===photo.sha1&&
      value.originalFileName===photo.filename&&value.isFavorite===favorite,"fixture_asset");
  });
}
async function stream(run:IntegrationRun,id:string,name:Session,expected:"snapshot"|"delta"|"reset",favorite:boolean,reset=false){
  const role=owner(name),own=run.state.data.assets[role],other=run.state.data.assets[role==="a"?"b":"a"];
  let rows:any[]=[];
  await run.execute({id,actor:role,call:{operation_id:"getSyncStream",body:{types:requestTypes,reset}},status:200,kind:"success",mutates:true,
    result_view:"complete_jsonl",context:selected(run,name),assertions:["complete_stream","owned_rows","fixture_change","protected_projection"]},async(result,check)=>{
      rows=await completeSyncRows(run,role,result);
      check(result.upstream.content_type==="application/jsonlines+json"&&rows.at(-1).type===(expected==="reset"?"SyncResetV1":"SyncCompleteV1")&&
        (expected!=="reset"||rows.length===1&&result.diagnostic?.code==="sync_reset_required"),"complete_stream");
      const users=rows.filter(value=>value.type==="AuthUserV2"),assets=rows.filter(value=>value.type==="AssetV2");
      check(rows.every(value=>["AuthUserV2","AssetV2","AssetDeleteV1","SyncCompleteV1","SyncResetV1"].includes(value.type))&&
        users.every(value=>value.data.id===run.context.actors[role].user_id)&&assets.every(value=>value.data.ownerId===run.context.actors[role].user_id&&value.data.id!==other.id),"owned_rows");
      const known=assets.find(value=>value.data.id===own.id),photo=syntheticPhoto(run.context.lab.state.id,role==="a"?"sync_a":"sync_b");
      check(expected==="reset"||known?.data.isFavorite===favorite&&known.data.checksum===photo.sha1&&known.data.originalFileName===photo.filename&&
        (expected!=="snapshot"||users.length===1),"fixture_change");
      // completeSyncRows checked every original against its sanitized page and
      // verified all non-null PIN secret references, including their scope.
      check(rows.length>0,"protected_projection");
    });
  return rows;
}
async function verify(run:IntegrationRun){
  for(const name of ["a","a_alt","b"] as const){
    await sessionIdentity(run,"final_child_"+name,name);
    await checkpoint(run,"final_checkpoints_"+name,name,run.state.data.final_acks[name]);
  }
  await asset(run,"final_asset_a","a",true);await asset(run,"final_asset_b","b",false);
  for(const role of ["a","restricted"] as const)await refused(run,"final_normal_key_sync_"+role,role,{operation_id:"getSyncAck"},403,false);
  await run.execute({id:"other_principal_context",actor:"b",call:{operation_id:"getSyncAck"},status:null,kind:"local_refusal",mutates:false,
    expected_error:"invalid_reference",context:selected(run,"a"),assertions:["context_isolation"]},(result,check)=>check(result.state==="locally_refused","context_isolation"));
}
async function seed(run:IntegrationRun){
  run.state.data={assets:{},contexts:{},parents:{},parent_ids:{},sessions:{},final_acks:{}};run.save();
  await connect(run);
  await refused(run,"normal_key_create_child","a",{operation_id:"createSession",body:{duration:86400}},400,true);
  for(const role of ["a","b"] as const){
    const photo=syntheticPhoto(run.context.lab.state.id,role==="a"?"sync_a":"sync_b"),p=run.context.actors[role].principal;
    const file=await run.staging.ingest(p,photo.filename,photo.mime,(async function*(){yield photo.bytes;})(),photo.bytes.length,undefined,photo.sha256);
    const result=await success(run,"upload_sync_"+role,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:photo.filename,fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,isFavorite:false,visibility:"timeline"}},201,true,["fresh_asset"],
      (result,check)=>check(result.data.status==="created"&&typeof result.data.id==="string","fresh_asset"));
    run.state.data.assets[role]={id:result.data.id};run.save();
  }
  for(const name of ["a","a_alt","b"] as const)await checkpoint(run,"empty_child_"+name,name,{});
  for(const role of ["a","restricted"] as const){
    await refused(run,"normal_key_stream_"+role,role,{operation_id:"getSyncStream",body:{types:requestTypes}},403,true);
    await refused(run,"normal_key_ack_"+role,role,{operation_id:"sendSyncAck",body:{acks:["AuthUserV2|not-sent"]}},403,true);
    await refused(run,"normal_key_delete_"+role,role,{operation_id:"deleteSyncAck",body:{types:["AuthUserV2"]}},403,true);
  }
  const first=lastAcks(await stream(run,"initial_stream_a","a","snapshot",false));
  await acknowledge(run,"store_initial_a","a",Object.values(first));await checkpoint(run,"saved_initial_a","a",first);
  await checkpoint(run,"same_owner_other_child_empty","a_alt",{});
  const b=lastAcks(await stream(run,"initial_stream_b","b","snapshot",false));
  await acknowledge(run,"store_initial_b","b",Object.values(b));await checkpoint(run,"saved_initial_b","b",b);
  await checkpoint(run,"a_unchanged_by_b","a",first);
  const alt=lastAcks(await stream(run,"initial_stream_a_alt","a_alt","snapshot",false));
  await acknowledge(run,"store_initial_a_alt","a_alt",Object.values(alt));await checkpoint(run,"saved_initial_a_alt","a_alt",alt);
  await checkpoint(run,"a_unchanged_by_other_child","a",first);
  await success(run,"favorite_sync_asset","a",{operation_id:"updateAsset",path:{id:run.state.data.assets.a.id},body:{isFavorite:true}},200,true,["favorite_changed"],
    (result,check)=>check(result.data.id===run.state.data.assets.a.id&&result.data.isFavorite===true,"favorite_changed"));
  await asset(run,"favorite_readback","a",true);
  // The fixed sync snapshot ends one millisecond before database now().
  await delay(5);
  const changed={...first,...lastAcks(await stream(run,"changed_asset_stream","a","delta",true))};
  await acknowledge(run,"store_changed_a","a",Object.values(changed));await checkpoint(run,"saved_changed_a","a",changed);
  await checkpoint(run,"b_unchanged_by_a","b",b);await checkpoint(run,"same_owner_child_unchanged","a_alt",alt);
  await success(run,"delete_asset_checkpoint","a",{operation_id:"deleteSyncAck",body:{types:["AssetV2"]}},204,true,["delete_acknowledged"],(result,check)=>check(result.upstream.status===204,"delete_acknowledged"),selected(run,"a"));
  const deleted={...changed};delete deleted.AssetV2;await checkpoint(run,"only_asset_checkpoint_deleted","a",deleted);
  await stream(run,"replayed_asset_after_delete","a","delta",true);
  await checkpoint(run,"stream_does_not_ack_itself","a",deleted);
  await acknowledge(run,"unknown_ack_type_refused","a",["UnknownFixtureEntity|invalid"],400);
  await checkpoint(run,"invalid_ack_did_not_change_state","a",deleted);
  await acknowledge(run,"store_stale_complete","a",[stale]);await checkpoint(run,"stale_checkpoint_saved","a",{...deleted,SyncCompleteV1:stale});
  const reset=await stream(run,"stale_state_requires_reset","a","reset",true);
  await acknowledge(run,"acknowledge_required_reset","a",[reset[0].ack]);await checkpoint(run,"reset_ack_clears_all","a",{});
  await acknowledge(run,"store_stale_again","a",[stale]);
  const explicit=await stream(run,"explicit_reset_returns_snapshot","a","snapshot",true,true);
  await checkpoint(run,"explicit_reset_clears_all","a",{});
  const fresh=lastAcks(explicit);await acknowledge(run,"store_after_explicit_reset","a",Object.values(fresh));await checkpoint(run,"saved_after_explicit_reset","a",fresh);
  await success(run,"request_session_reset","a",{operation_id:"updateSession",path:{id:run.state.data.sessions.a.id},body:{isPendingSyncReset:true}},200,true,["pending_reset"],
    (result,check)=>check(result.data.id===run.state.data.sessions.a.id&&result.data.isPendingSyncReset===true,"pending_reset"));
  const pending=await stream(run,"pending_session_requires_reset","a","reset",true);
  await acknowledge(run,"acknowledge_pending_reset","a",[pending[0].ack]);await checkpoint(run,"pending_reset_ack_clears_all","a",{});
  const final=lastAcks(await stream(run,"final_snapshot_after_reset","a","snapshot",true));
  await acknowledge(run,"store_final_a","a",Object.values(final));
  run.state.data.final_acks={a:final,a_alt:alt,b};run.save();
}
export async function createSyncFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,SYNC_PLAN);
    try{
      if(!run.revalidate)await seed(run);
      await verify(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"sync_fixtures_revalidated":"sync_fixtures_ready",execution_scope:run.state.execution_scope,synthetic_assets:2,child_sessions:3,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Sync completion is committed; retry non-mutating verification and report publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve the original sent receipt; never resend acknowledgements or session creation. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing sync fixtures failed verification; no stream/reset/ack/session mutation was replayed");
      return integrationFailure("fixture_recovery_required","Sync setup did not finish; retain its private checkpoint/session evidence and prepare a new disposable run");
    }
  },options);
}
