import { createHash,randomBytes,randomInt } from "node:crypto";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure,type CaseContext } from "./integration-run.js";
import { syntheticPhoto,FIXTURE_DATE } from "./integration-media.js";
import { readDecoded } from "./content-encoding.js";
import { BridgeError,type ApiCall } from "./types.js";

export const AUTH_PLAN="auth_contexts_v1";
type Photo="link_a"|"locked_a"|"auth_b";
type Check=(value:unknown,id:string)=>void;
const principal=(run:IntegrationRun,role:FixtureRole)=>run.context.actors[role].principal;
const selected=(run:IntegrationRun,name:string):CaseContext=>run.state.data.contexts[name];
const photoOwner=(name:Photo):FixtureRole=>name==="auth_b"?"b":"a";

async function success(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],
  verify:(data:any,check:Check,result:any)=>void|Promise<void>,context?:CaseContext){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions,context},(result,check)=>verify(result.data,check,result));
}
async function refuse(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,context?:CaseContext,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["exact_upstream_refusal"],context},
    (result,check)=>check(result.upstream?.status===status,"exact_upstream_refusal"));
}
async function local(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,context:CaseContext,error:string){
  return run.execute({id,actor,call,status:null,mutates:false,kind:"local_refusal",expected_error:error,assertions:["refused_before_dispatch"],context},
    (result,check)=>check(result.state==="locally_refused"&&result.diagnostic.code===error,"refused_before_dispatch"));
}
async function status(run:IntegrationRun,id:string,actor:FixtureRole,pin:boolean,elevated:boolean,context?:CaseContext){
  return success(run,id,actor,{operation_id:"getAuthStatus"},200,false,["pin_configuration","session_elevation"],(data,check)=>{
    check(data.pinCode===pin&&data.password===true,"pin_configuration");check(data.isElevated===elevated,"session_elevation");
  },context);
}
async function asset(run:IntegrationRun,id:string,actor:FixtureRole,name:Photo,context?:CaseContext){
  const expected=run.state.data.assets[name],media=syntheticPhoto(run.context.lab.state.id,name);
  return success(run,id,actor,{operation_id:"getAssetInfo",path:{id:expected.id}},200,false,["asset_identity","asset_owner","asset_checksum","visibility"],(data,check)=>{
    check(data.id===expected.id,"asset_identity");check(data.ownerId===run.context.actors[photoOwner(name)].user_id,"asset_owner");
    check(data.checksum===media.sha1,"asset_checksum");check(data.visibility===(name==="locked_a"?"locked":"timeline"),"visibility");
  },context);
}
async function binary(run:IntegrationRun,id:string,actor:FixtureRole,name:Photo,context:CaseContext){
  const expected=syntheticPhoto(run.context.lab.state.id,name);
  return success(run,id,actor,{operation_id:"downloadAsset",path:{id:run.state.data.assets[name].id}},200,false,["exact_bytes","sha256"],async(_data,check,result)=>{
    const p=principal(run,actor),record=run.context.vault.get(p,result.result_ref,"result");
    run.contexts.assertResult(p,record);
    const bytes=await readDecoded(run.context.vault.rawStream(p,record.raw.raw_ref),record.raw.content_encoding??"identity",1024*1024);
    check(bytes.equals(expected.bytes),"exact_bytes");check(createHash("sha256").update(bytes).digest("hex")===expected.sha256,"sha256");
  },context);
}
function keyFromResult(run:IntegrationRun,result:any){
  const p=principal(run,"a"),record=run.context.vault.get(p,result.result_ref,"result");
  run.contexts.assertResult(p,record);
  if(typeof result.data?.key?.secret_ref!=="string")return integrationFailure("fixture_secret","Shared-link key was not protected");
  const secret=run.context.vault.get(p,result.data.key.secret_ref,"secret");
  if(record.display.operation_id!=="createSharedLink"||secret.revision!==record.revision||secret.context_ref!==record.context_ref||typeof secret.value!=="string"||!secret.value)
    return integrationFailure("fixture_secret","Shared-link key provenance differs");
  return secret.value as string;
}
async function connectSession(run:IntegrationRun,role:"a"|"b"){
  const p=principal(run,role),actor=run.context.vault.get(p,"actor","fixture_actor");
  if(actor.role!==role||actor.owner!==role||actor.user_id!==run.context.actors[role].user_id||typeof actor.session!=="string")
    integrationFailure("fixture_session","Expected the original synthetic owner's setup session");
  const c=await run.contexts.register(p,{kind:"session",credential:actor.session,acknowledge:true,ttl_seconds:86400});
  if(c.mode!=="special"||c.api_key_permissions_inherited!==false)integrationFailure("fixture_consent","Session registration changed its default authorization mode");
  run.state.data.contexts[role]={ref:c.context_ref,generation:c.generation};run.save();
}
function enableGeneral(run:IntegrationRun,role:"a"|"b"){
  const old=selected(run,role),p=principal(run,role),c=run.contexts.setSessionMode(p,old.ref,old.generation,true,true);
  if(c.mode!=="general_session"||c.api_key_permissions_inherited!==false)integrationFailure("fixture_consent","Expected explicitly selected general-session mode");
  run.state.data.contexts[role]={ref:c.context_ref,generation:c.generation};run.save();
}
async function getLink(run:IntegrationRun,id:string,name:"main"|"limited",context:CaseContext){
  const link=run.state.data.links[name],assetId=run.state.data.assets.link_a.id;
  return success(run,id,"b",{operation_id:"getMySharedLink"},200,false,["link_identity","link_owner","exact_asset_membership","download_policy","protected_credential"],(data,check)=>{
    check(data.id===link.id,"link_identity");check(data.userId===run.context.actors.a.user_id,"link_owner");
    check(data.assets.length===1&&data.assets[0].id===assetId,"exact_asset_membership");check(data.allowDownload===(name==="main")&&data.allowUpload===false,"download_policy");
    check(typeof data.key?.secret_ref==="string"&&typeof data.password?.secret_ref==="string","protected_credential");
  },context);
}
async function login(run:IntegrationRun,id:string,name:"main_key"|"main_slug"|"limited",password:string,statusCode=201){
  const context=selected(run,name),call=run.protect("b",{operation_id:"sharedLinkLogin",body:{}},{"/password":password},context);
  if(statusCode!==201)return refuse(run,id,"b",call,statusCode,context,true);
  const link=run.state.data.links[name==="limited"?"limited":"main"];
  return success(run,id,"b",call,201,true,["authenticated_link","protected_key"],(data,check)=>{
    check(data.id===link.id&&data.userId===run.context.actors.a.user_id,"authenticated_link");check(typeof data.key?.secret_ref==="string","protected_key");
  },context);
}
async function seed(run:IntegrationRun){
  const pin=randomInt(1000000).toString().padStart(6,"0"),wrong=((Number(pin)+1)%1000000).toString().padStart(6,"0");
  run.state.data={assets:{},contexts:{},links:{},pin,wrong_pin:wrong,passwords:{main:randomBytes(24).toString("hex"),limited:randomBytes(24).toString("hex"),rotated:randomBytes(24).toString("hex")}};run.save();
  for(const name of ["link_a","locked_a","auth_b"] as const){
    const actor=photoOwner(name),p=principal(run,actor),photo=syntheticPhoto(run.context.lab.state.id,name);
    const file=await run.staging.ingest(p,photo.filename,photo.mime,(async function*(){yield photo.bytes;})(),photo.bytes.length,undefined,photo.sha256);
    const result=await success(run,"upload_"+name,actor,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:photo.filename,fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,visibility:"timeline"}},201,true,["fresh_asset"],
      (data,check)=>check(data.status==="created"&&typeof data.id==="string","fresh_asset"));
    run.state.data.assets[name]={id:result.data.id};run.save();
  }
  await connectSession(run,"a");await connectSession(run,"b");
  for(const role of ["a","b"] as const){
    const context=selected(run,role);
    await success(run,"own_session_"+role,role,{operation_id:"getSessions"},200,false,["one_current_session","special_mode","explicit_mode_consent"],(data,check)=>{
      const current=data.filter((s:any)=>s.current);
      check(current.length===1&&typeof current[0].id==="string","one_current_session");
      check(run.contexts.describe(principal(run,role),context.ref).mode==="special","special_mode");
      let denied=false;try{run.contexts.setSessionMode(principal(run,role),context.ref,context.generation,true,false);}catch(error){denied=error instanceof BridgeError&&error.code==="context_consent";}
      check(denied&&run.contexts.describe(principal(run,role),context.ref).generation===context.generation,"explicit_mode_consent");
      run.state.data["session_"+role]=current[0].id;run.save();
    },context);
  }
  if(run.state.data.session_a===run.state.data.session_b)integrationFailure("fixture_session","Distinct fixture owners received the same session");
  await status(run,"initial_pin_status","a",false,false,selected(run,"a"));
  const setup=run.protect("a",{operation_id:"setupPinCode",body:{}},{"/pinCode":pin});
  await success(run,"setup_pin","a",setup,204,true,["no_content"],(_data,check,result)=>check(result.upstream.status===204,"no_content"));
  await status(run,"pin_configured_api_key","a",true,false);
  const locked=run.state.data.assets.locked_a.id;
  await success(run,"lock_asset","a",{operation_id:"updateAsset",path:{id:locked},body:{visibility:"locked"}},200,true,["locked_visibility"],
    (data,check)=>check(data.id===locked&&data.visibility==="locked","locked_visibility"));
  await refuse(run,"api_key_cannot_read_locked_before","a",{operation_id:"getAssetInfo",path:{id:locked}},400);
  await local(run,"special_mode_blocks_general_asset","a",{operation_id:"getAssetInfo",path:{id:locked}},selected(run,"a"),"context_purpose");
  await local(run,"other_principal_context_refused","b",{operation_id:"getAuthStatus"},selected(run,"a"),"invalid_reference");
  const keyUnlock=run.protect("a",{operation_id:"unlockAuthSession",body:{}},{"/pinCode":pin});
  await refuse(run,"api_key_unlock_requires_session","a",keyUnlock,400,undefined,true);
  const wrongUnlock=run.protect("a",{operation_id:"unlockAuthSession",body:{}},{"/pinCode":wrong},selected(run,"a"));
  await refuse(run,"wrong_pin_refused","a",wrongUnlock,400,selected(run,"a"),true);
  const unlock=run.protect("a",{operation_id:"unlockAuthSession",body:{}},{"/pinCode":pin},selected(run,"a"));
  await success(run,"explicit_session_unlock","a",unlock,204,true,["no_content"],(_data,check,result)=>check(result.upstream.status===204,"no_content"),selected(run,"a"));
  await status(run,"session_elevated","a",true,true,selected(run,"a"));
  await local(run,"unlock_does_not_enable_general_mode","a",{operation_id:"getAssetInfo",path:{id:locked}},selected(run,"a"),"context_purpose");
  enableGeneral(run,"a");enableGeneral(run,"b");
  await asset(run,"elevated_owner_asset","a","locked_a",selected(run,"a"));
  await binary(run,"elevated_owner_original","a","locked_a",selected(run,"a"));
  await refuse(run,"api_key_stays_unelevated","a",{operation_id:"getAssetInfo",path:{id:locked}},400);
  await refuse(run,"other_session_not_elevated","b",{operation_id:"getAssetInfo",path:{id:locked}},400,selected(run,"b"));
  await refuse(run,"restricted_key_no_session_fallback","restricted",{operation_id:"downloadAsset",path:{id:locked}},403);
  await success(run,"explicit_session_relock","a",{operation_id:"lockAuthSession"},204,true,["no_content"],
    (_data,check,result)=>check(result.upstream.status===204,"no_content"),selected(run,"a"));

  for(const name of ["main","limited"] as const){
    const slug=name==="main"?"mcp-"+run.context.lab.state.id:null;
    const secrets:Record<string,string>={"/password":run.state.data.passwords[name]};if(slug)secrets["/slug"]=slug;
    const call=run.protect("a",{operation_id:"createSharedLink",body:{type:"INDIVIDUAL",assetIds:[run.state.data.assets.link_a.id],
      allowDownload:name==="main",allowUpload:false,showMetadata:true,...(slug===null?{slug:null}:{}),expiresAt:null}},secrets);
    const result=await success(run,"create_link_"+name,"a",call,201,true,["link_owner","asset_membership","link_policy","protected_key"],(data,check)=>{
      check(data.userId===run.context.actors.a.user_id,"link_owner");check(data.assets.length===1&&data.assets[0].id===run.state.data.assets.link_a.id,"asset_membership");
      check(data.allowDownload===(name==="main")&&data.allowUpload===false,"link_policy");check(typeof data.key?.secret_ref==="string","protected_key");
    });
    run.state.data.links[name]={id:result.data.id,key:keyFromResult(run,result),slug};run.save();
  }
  for(const name of ["main_key","main_slug","limited"] as const){
    const link=run.state.data.links[name==="limited"?"limited":"main"],kind=name==="main_slug"?"slug":"key";
    const c=await run.contexts.register(principal(run,"b"),{kind:"shared_link",credential:kind==="slug"?link.slug:link.key,share_type:kind,acknowledge:true,ttl_seconds:86400});
    run.state.data.contexts[name]={ref:c.context_ref,generation:c.generation};run.save();
  }
  await refuse(run,"password_required_key","b",{operation_id:"getMySharedLink"},401,selected(run,"main_key"));
  await login(run,"wrong_link_password","main_key",run.state.data.passwords.limited,401);
  await login(run,"login_main_key","main_key",run.state.data.passwords.main);
  await getLink(run,"main_key_link","main",selected(run,"main_key"));
  await binary(run,"main_key_original","b","link_a",selected(run,"main_key"));
  await refuse(run,"slug_context_has_no_key_cookie","b",{operation_id:"getMySharedLink"},401,selected(run,"main_slug"));
  await login(run,"login_main_slug","main_slug",run.state.data.passwords.main);
  await getLink(run,"main_slug_link","main",selected(run,"main_slug"));
  await refuse(run,"second_link_has_no_first_cookie","b",{operation_id:"getMySharedLink"},401,selected(run,"limited"));
  await login(run,"other_link_password_refused","limited",run.state.data.passwords.main,401);
  await login(run,"login_limited","limited",run.state.data.passwords.limited);
  await getLink(run,"limited_link_initial","limited",selected(run,"limited"));
  const main=run.state.data.links.main;
  const rotate=run.protect("a",{operation_id:"updateSharedLink",path:{id:main.id},body:{}},{"/password":run.state.data.passwords.rotated,"/slug":main.slug});
  await success(run,"rotate_link_password","a",rotate,200,true,["same_link","protected_password"],
    (data,check)=>{check(data.id===main.id,"same_link");check(typeof data.password?.secret_ref==="string","protected_password");});
  await refuse(run,"old_key_cookie_invalidated","b",{operation_id:"getMySharedLink"},401,selected(run,"main_key"));
  await refuse(run,"old_slug_cookie_invalidated","b",{operation_id:"getMySharedLink"},401,selected(run,"main_slug"));
  await login(run,"login_rotated_password","main_key",run.state.data.passwords.rotated);
  await getLink(run,"rotated_key_link","main",selected(run,"main_key"));
  const expire=run.protect("a",{operation_id:"updateSharedLink",path:{id:main.id},body:{expiresAt:"2020-01-01T00:00:00.000Z"}},{"/slug":main.slug});
  await success(run,"expire_main_link","a",expire,200,true,["past_expiration"],
    (data,check)=>check(data.id===main.id&&data.expiresAt==="2020-01-01T00:00:00.000Z","past_expiration"));
}
async function verify(run:IntegrationRun){
  await status(run,"final_api_key_pin_status","a",true,false);
  await status(run,"final_session_locked","a",true,false,selected(run,"a"));
  await status(run,"other_session_unchanged","b",false,false,selected(run,"b"));
  const locked=run.state.data.assets.locked_a.id,linkAsset=run.state.data.assets.link_a.id;
  await refuse(run,"relocked_asset_session","a",{operation_id:"getAssetInfo",path:{id:locked}},400,selected(run,"a"));
  await refuse(run,"relocked_original_session","a",{operation_id:"downloadAsset",path:{id:locked}},400,selected(run,"a"));
  await refuse(run,"relocked_asset_api_key","a",{operation_id:"getAssetInfo",path:{id:locked}},400);
  await local(run,"cross_principal_context_stays_private","b",{operation_id:"getAuthStatus"},selected(run,"a"),"invalid_reference");
  await refuse(run,"normal_key_has_no_shared_link_context","b",{operation_id:"getMySharedLink"},403);
  await refuse(run,"normal_key_has_no_link_cookie","b",{operation_id:"getAssetInfo",path:{id:linkAsset}},400);
  await refuse(run,"expired_key_refused","b",{operation_id:"getMySharedLink"},401,selected(run,"main_key"));
  await refuse(run,"expired_slug_refused","b",{operation_id:"getMySharedLink"},401,selected(run,"main_slug"));
  await getLink(run,"limited_link_final","limited",selected(run,"limited"));
  await refuse(run,"link_download_policy_refused","b",{operation_id:"downloadAsset",path:{id:linkAsset}},400,selected(run,"limited"));
  await refuse(run,"link_excludes_locked_asset","b",{operation_id:"getAssetInfo",path:{id:locked}},400,selected(run,"limited"));
  await refuse(run,"link_excludes_other_owner_asset","b",{operation_id:"getAssetInfo",path:{id:run.state.data.assets.auth_b.id}},400,selected(run,"limited"));
  await asset(run,"ordinary_owner_asset","a","link_a");
  await asset(run,"other_owner_private_asset","b","auth_b");
}
export async function createAuthFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,AUTH_PLAN);
    try{
      if(!run.revalidate)await seed(run);
      await verify(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"auth_fixtures_revalidated":"auth_fixtures_ready",execution_scope:run.state.execution_scope,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Authentication fixture completion is committed; retry read-only verification and publication");
      try{run.fail(error);await run.publish();}catch{/* Retain the encrypted started/sent fence. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing authentication fixtures no longer match; no upstream mutation was replayed");
      return integrationFailure("fixture_recovery_required","Authentication fixtures did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
