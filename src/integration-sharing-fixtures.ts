import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto,FIXTURE_DATE } from "./integration-media.js";
import { fixtureStoredZip } from "./integration-zip.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

export const SHARING_PLAN="sharing_fixtures_v1";
const variants=["sharing_album_a","sharing_private_a","sharing_download_a","sharing_b"] as const;
type Variant=typeof variants[number];type Role="a"|"b";type Check=(condition:unknown,id:string)=>void;
const owner=(v:Variant):Role=>v==="sharing_b"?"b":"a";
const photo=(run:IntegrationRun,v:Variant)=>syntheticPhoto(run.context.lab.state.id,v);
const assetId=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v].id;
const sameIds=(a:string[],b:string[])=>a.length===b.length&&a.toSorted().every((id,i)=>id===b.toSorted()[i]);
async function json(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},(result,check)=>verify(result.data,check));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
async function readAsset(run:IntegrationRun,id:string,actor:FixtureRole,v:Variant){
  const p=photo(run,v);
  return json(run,id,actor,{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,["asset_identity","original_metadata"],(data,check)=>{
    check(data.id===assetId(run,v)&&data.ownerId===run.context.actors[owner(v)].user_id&&data.checksum===p.sha1&&data.isFavorite===false,"asset_identity");
    check(data.originalFileName===p.filename&&data.exifInfo?.fileSizeInByte===p.bytes.length,"original_metadata");
  });
}
async function partners(run:IntegrationRun,id:string,actor:Role,direction:"shared-by"|"shared-with",added?:{peer:Role;inTimeline:boolean},baseline=false){
  const peer=actor==="a"?"b":"a",peerId=run.context.actors[peer].user_id;
  const result=await json(run,id,actor,{operation_id:"getPartners",query:{direction}},200,false,["partner_direction"],(data,check)=>{
    const actual=data.map((p:any)=>p.id),expected=run.state.data.baseline[actor][direction];
    check(Array.isArray(data)&&(baseline?!actual.includes(peerId):sameIds(actual,[...expected,...(added?[run.context.actors[added.peer].user_id]:[])]))&&
      (!added||data.some((p:any)=>p.id===run.context.actors[added.peer].user_id&&p.inTimeline===added.inTimeline)),"partner_direction");
  });
  if(baseline){run.state.data.baseline[actor][direction]=result.data.map((p:any)=>p.id).toSorted();run.save();}
}
async function archive(run:IntegrationRun,id:string,actor:Role,selected:Variant[]){
  const occurrences=new Map<string,number>(),expected=selected.map(v=>{
    const p=photo(run,v),count=occurrences.get(p.filename)??0;occurrences.set(p.filename,count+1);
    return {name:count?p.filename.slice(0,-4)+"+"+count+".png":p.filename,photo:p};
  });
  await run.execute({id,actor,call:{operation_id:"downloadArchive",body:{assetIds:selected.map(v=>assetId(run,v)),edited:false,archiveName:"MCP-\u8a66\u9a13-"+run.context.lab.state.id}},status:200,mutates:true,kind:"success",
    assertions:["zip_membership","exact_original_bytes"]},async(result,check)=>{
    const principal=run.context.actors[actor].principal,stored=run.context.vault.get(principal,result.result_ref,"result");
    const raw=await readDecoded(run.context.vault.rawStream(principal,stored.raw.raw_ref),stored.raw.content_encoding??"identity",2*1024*1024),entries=fixtureStoredZip(raw);
    check(sameIds(entries.map(e=>e.name),expected.map(e=>e.name)),"zip_membership");
    check(entries.every(e=>{const p=expected.find(p=>p.name===e.name)!.photo;return e.bytes.equals(p.bytes)&&createHash("sha256").update(e.bytes).digest("hex")===p.sha256;}),"exact_original_bytes");
  });
}
async function info(run:IntegrationRun,id:string,actor:Role,selected:Variant[],album=false,small=false){
  const expected=selected.map(v=>assetId(run,v)),size=(ids:string[])=>ids.reduce((sum,id)=>sum+photo(run,selected.find(v=>assetId(run,v)===id)!).bytes.length,0);
  await json(run,id,actor,{operation_id:"getDownloadInfo",body:{...(album?{albumId:run.state.data.album.id}:{assetIds:expected}),archiveSize:small?1:1024*1024}},201,true,
    ["archive_groups","original_sizes"],(data,check)=>{
    const groups=data.archives,flat=groups.flatMap((g:any)=>g.assetIds);
    check(Array.isArray(groups)&&sameIds(flat,expected)&&groups.every((g:any)=>g.assetIds.length>0)&&
      (!small||groups.length===selected.length&&groups.every((g:any)=>g.assetIds.length===1)),"archive_groups");
    check(data.totalSize===size(expected)&&groups.every((g:any)=>g.size===size(g.assetIds)),"original_sizes");
  });
}
async function upload(run:IntegrationRun){
  for(const v of variants){
    const p=photo(run,v),role=owner(v),file=await run.staging.ingest(run.context.actors[role].principal,p.filename,p.mime,(async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
    const result=await json(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:p.filename,fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,isFavorite:false,visibility:"timeline"}},201,true,["new_asset"],
      (data,check)=>check(data.status==="created"&&typeof data.id==="string","new_asset"));
    run.state.data.assets[v]={id:result.data.id};run.save();
  }
  for(const v of variants){
    let ready=false;
    for(let attempt=0;attempt<20;attempt++){
      await json(run,"metadata_"+v+"_"+attempt,owner(v),{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,["known_asset"],(data,check)=>{
        check(data.id===assetId(run,v)&&data.checksum===photo(run,v).sha1,"known_asset");ready=data.exifInfo?.fileSizeInByte===photo(run,v).bytes.length;
      });
      if(ready)break;if(attempt<19)await delay(1000);
    }
    if(!ready)integrationFailure("fixture_metadata_timeout","Synthetic archive metadata did not become ready");
  }
}
const comment=(run:IntegrationRun,label:string)=>"MCP \u30b3\u30e1\u30f3\u30c8 "+label+" "+run.context.lab.state.id;
async function activity(run:IntegrationRun,id:string,actor:Role,type:"like"|"comment",asset:boolean,label:string,duplicate?:string){
  const body={albumId:run.state.data.album.id,type,...(asset?{assetId:assetId(run,"sharing_album_a")}:{}),...(type==="comment"?{comment:comment(run,label)}:{})};
  return json(run,id,actor,{operation_id:"createActivity",body},duplicate?200:201,true,["activity_identity"],(data,check)=>{
    check(typeof data.id==="string"&&(!duplicate||data.id===duplicate)&&data.user.id===run.context.actors[actor].user_id&&data.type===type&&
      data.assetId===(asset?assetId(run,"sharing_album_a"):null)&&(type==="like"?!data.comment:data.comment===comment(run,label)),"activity_identity");
  });
}
async function statistics(run:IntegrationRun,id:string,actor:FixtureRole,comments:number,likes:number,asset=false){
  await json(run,id,actor,{operation_id:"getActivityStatistics",query:{albumId:run.state.data.album.id,...(asset?{assetId:assetId(run,"sharing_album_a")}:{})}},200,false,
    ["activity_counts"],(data,check)=>check(data.comments===comments&&data.likes===likes,"activity_counts"));
}
async function seedAlbumActivities(run:IntegrationRun){
  const d=run.state.data,name="MCP social "+run.context.lab.state.id;
  const result=await json(run,"create_social_album","a",{operation_id:"createAlbum",body:{albumName:name}},201,true,["new_album"],
    (data,check)=>check(typeof data.id==="string"&&data.albumName===name&&data.assetCount===0,"new_album"));
  d.album={id:result.data.id,name};run.save();
  await json(run,"add_social_asset","a",{operation_id:"addAssetsToAlbum",path:{id:d.album.id},body:{ids:[assetId(run,"sharing_album_a")]}},200,true,["asset_added"],
    (data,check)=>check(data.length===1&&data[0].id===assetId(run,"sharing_album_a")&&data[0].success===true,"asset_added"));
  await refused(run,"unshared_activities","b",{operation_id:"getActivities",query:{albumId:d.album.id}},400);
  await refused(run,"unshared_comment","b",{operation_id:"createActivity",body:{albumId:d.album.id,type:"comment",comment:comment(run,"refused")}},400,true);
  await refused(run,"unshared_download_info","b",{operation_id:"getDownloadInfo",body:{albumId:d.album.id}},400,true);
  await json(run,"share_social_album","a",{operation_id:"addUsersToAlbum",path:{id:d.album.id},body:{albumUsers:[{userId:run.context.actors.b.user_id,role:"viewer"}]}},200,true,["viewer_added"],
    (data,check)=>check(data.albumUsers.some((u:any)=>u.user.id===run.context.actors.b.user_id&&u.role==="viewer"),"viewer_added"));
  for(const enabled of [false,true]){
    await json(run,"activity_enabled_"+enabled,"a",{operation_id:"updateAlbumInfo",path:{id:d.album.id},body:{isActivityEnabled:enabled}},200,true,["activity_flag"],
      (data,check)=>check(data.isActivityEnabled===enabled,"activity_flag"));
    if(!enabled)await refused(run,"disabled_comment","b",{operation_id:"createActivity",body:{albumId:d.album.id,type:"comment",comment:comment(run,"disabled")}},400,true);
  }
  const created=[
    ["owner","a","comment",false],["like","b","like",true],["delete_owner","b","comment",true],
    ["delete_author","b","comment",false],["delete_like","a","like",false]
  ] as const;
  for(const [key,role,type,asset] of created){const r=await activity(run,"create_activity_"+key,role,type,asset,key);d.activities[key]={id:r.data.id,actor:role,type,asset,comment:type==="comment"?comment(run,key):null};run.save();}
  await activity(run,"duplicate_asset_like","b","like",true,"like",d.activities.like.id);
  await statistics(run,"activities_before_delete","a",3,2);
  await refused(run,"nonmember_delete_activity","admin",{operation_id:"deleteActivity",path:{id:d.activities.delete_owner.id}},400,true);
  await refused(run,"viewer_delete_owner_comment","b",{operation_id:"deleteActivity",path:{id:d.activities.owner.id}},400,true);
  for(const [key,actor] of [["delete_owner","a"],["delete_author","b"],["delete_like","a"]] as const)
    await json(run,"delete_activity_"+key,actor,{operation_id:"deleteActivity",path:{id:d.activities[key].id}},204,true,["delete_ack"],(_data,check)=>check(true,"delete_ack"));
  await refused(run,"invalid_empty_comment","b",{operation_id:"createActivity",body:{albumId:d.album.id,type:"comment",comment:" "}},400,true);
  for(const call of [
    {operation_id:"createActivity",body:{albumId:d.album.id,type:"comment",comment:comment(run,"restricted")}},
    {operation_id:"deleteActivity",path:{id:d.activities.owner.id}}
  ] as ApiCall[])await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,true);
}
async function seedPartnersDownloads(run:IntegrationRun){
  const d=run.state.data,a=run.context.actors.a.user_id,b=run.context.actors.b.user_id,privateA=assetId(run,"sharing_private_a"),privateB=assetId(run,"sharing_b");
  await refused(run,"private_a_before_partner","b",{operation_id:"getAssetInfo",path:{id:privateA}},400);
  await refused(run,"private_b_before_partner","a",{operation_id:"getAssetInfo",path:{id:privateB}},400);
  await info(run,"owner_split_info","a",["sharing_private_a","sharing_download_a"],false,true);
  await archive(run,"owner_archive","a",["sharing_private_a","sharing_download_a"]);
  await archive(run,"duplicate_filename_archive","a",["sharing_private_a","sharing_private_a"]);
  await info(run,"viewer_album_info","b",["sharing_album_a"],true);await archive(run,"viewer_album_archive","b",["sharing_album_a"]);
  for(const operation_id of ["getDownloadInfo","downloadArchive"])await refused(run,"mixed_owner_"+operation_id.toLowerCase(),"a",{operation_id,body:{assetIds:[privateA,privateB]}},400,true);
  await json(run,"create_partner_a_to_b","a",{operation_id:"createPartner",body:{sharedWithId:b}},201,true,["new_partner"],
    (data,check)=>check(data.id===b&&data.inTimeline===false,"new_partner"));
  await partners(run,"outgoing_partner_a","a","shared-by",{peer:"b",inTimeline:false});
  await partners(run,"incoming_partner_b","b","shared-with",{peer:"a",inTimeline:false});
  await readAsset(run,"partner_read_without_timeline","b","sharing_private_a");
  await info(run,"partner_asset_info","b",["sharing_private_a","sharing_download_a"]);await archive(run,"partner_archive","b",["sharing_private_a"]);
  await refused(run,"partner_user_wide_download","b",{operation_id:"getDownloadInfo",body:{userId:a}},400,true);
  await refused(run,"partner_update_asset","b",{operation_id:"updateAsset",path:{id:privateA},body:{isFavorite:true}},400,true);
  await refused(run,"giver_cannot_update_incoming","a",{operation_id:"updatePartner",path:{id:b},body:{inTimeline:true}},400,true);
  await refused(run,"duplicate_partner","a",{operation_id:"createPartner",body:{sharedWithId:b}},400,true);
  await json(run,"recipient_enable_timeline","b",{operation_id:"updatePartner",path:{id:a},body:{inTimeline:true}},200,true,["updated_partner"],
    (data,check)=>check(data.id===a&&data.inTimeline===true,"updated_partner"));
  await partners(run,"updated_incoming_b","b","shared-with",{peer:"a",inTimeline:true});
  await json(run,"create_deprecated_partner_b_to_a","b",{operation_id:"createPartnerDeprecated",path:{id:a}},201,true,["reverse_partner"],
    (data,check)=>check(data.id===a&&data.inTimeline===false,"reverse_partner"));
  await readAsset(run,"reverse_partner_read","a","sharing_b");
  await json(run,"recipient_update_reverse","a",{operation_id:"updatePartner",path:{id:b},body:{inTimeline:true}},200,true,["reverse_updated"],
    (data,check)=>check(data.id===b&&data.inTimeline===true,"reverse_updated"));
  await partners(run,"reverse_incoming_a","a","shared-with",{peer:"b",inTimeline:true});
  await refused(run,"nonrecipient_update_partner","admin",{operation_id:"updatePartner",path:{id:a},body:{inTimeline:true}},400,true);
  await refused(run,"nongiver_remove_partner","admin",{operation_id:"removePartner",path:{id:b}},400,true);
  for(const call of [
    {operation_id:"createPartner",body:{sharedWithId:b}},{operation_id:"createPartnerDeprecated",path:{id:b}},
    {operation_id:"updatePartner",path:{id:b},body:{inTimeline:false}},{operation_id:"removePartner",path:{id:b}},
    {operation_id:"getDownloadInfo",body:{assetIds:[privateA]}},{operation_id:"downloadArchive",body:{assetIds:[privateA]}}
  ] as ApiCall[])await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,true);
  await json(run,"remove_b_to_a","b",{operation_id:"removePartner",path:{id:a}},204,true,["remove_ack"],(_data,check)=>check(true,"remove_ack"));
  await refused(run,"reverse_access_revoked","a",{operation_id:"getAssetInfo",path:{id:privateB}},400);
  await readAsset(run,"forward_access_preserved","b","sharing_private_a");
  await json(run,"remove_a_to_b","a",{operation_id:"removePartner",path:{id:b}},204,true,["remove_ack"],(_data,check)=>check(true,"remove_ack"));
  for(const operation_id of ["getDownloadInfo","downloadArchive"])await refused(run,"revoked_"+operation_id.toLowerCase(),"b",{operation_id,body:{assetIds:[privateA]}},400,true);
}
async function verifySharing(run:IntegrationRun){
  const d=run.state.data;
  for(const actor of ["a","b"] as const)for(const direction of ["shared-by","shared-with"] as const)await partners(run,"final_"+actor+"_"+direction.replace("-","_"),actor,direction);
  for(const actor of ["a","b"] as const){
    await json(run,"final_album_"+actor,actor,{operation_id:"getAlbumInfo",path:{id:d.album.id}},200,false,["album_identity","album_sharing"],(data,check)=>{
      check(data.id===d.album.id&&data.albumName===d.album.name&&data.assetCount===1&&data.isActivityEnabled===true,"album_identity");
      check(data.albumUsers.some((u:any)=>u.user.id===run.context.actors.a.user_id&&u.role==="owner")&&data.albumUsers.some((u:any)=>u.user.id===run.context.actors.b.user_id&&u.role==="viewer"),"album_sharing");
    });
    await statistics(run,"final_statistics_"+actor,actor,1,1);await statistics(run,"final_asset_statistics_"+actor,actor,0,1,true);
  }
  const queries=[
    ["all",{},["owner","like"]],["comments",{type:"comment"},["owner"]],["likes",{type:"like"},["like"]],
    ["album",{level:"album"},["owner"]],["asset",{level:"asset",assetId:assetId(run,"sharing_album_a")},["like"]],
    ["author_a",{userId:run.context.actors.a.user_id},["owner"]],["author_b",{userId:run.context.actors.b.user_id},["like"]]
  ] as const;
  for(const [id,query,keys] of queries)await json(run,"final_activities_"+id,"a",{operation_id:"getActivities",query:{albumId:d.album.id,...query}},200,false,["exact_activities"],(data,check)=>{
    check(Array.isArray(data)&&sameIds(data.map((a:any)=>a.id),keys.map(k=>d.activities[k].id))&&data.every((a:any)=>{
      const expected=keys.map(k=>d.activities[k]).find(e=>e.id===a.id);
      return expected&&a.user.id===run.context.actors[expected.actor as Role].user_id&&a.type===expected.type&&
        a.assetId===(expected.asset?assetId(run,"sharing_album_a"):null)&&(expected.type!=="comment"||a.comment===expected.comment);
    }),"exact_activities");
  });
  await json(run,"final_viewer_activities","b",{operation_id:"getActivities",query:{albumId:d.album.id}},200,false,["same_visible_activities"],
    (data,check)=>check(sameIds(data.map((a:any)=>a.id),[d.activities.owner.id,d.activities.like.id]),"same_visible_activities"));
  for(const actor of ["restricted","admin"] as const)for(const operation_id of ["getActivities","getActivityStatistics"])await refused(run,"final_"+actor+"_"+operation_id.toLowerCase(),actor,{operation_id,query:{albumId:d.album.id}},actor==="restricted"?403:400);
  await refused(run,"final_restricted_partners","restricted",{operation_id:"getPartners",query:{direction:"shared-by"}},403);
  for(const v of variants)await readAsset(run,"final_asset_"+v,owner(v),v);
  await readAsset(run,"final_viewer_asset","b","sharing_album_a");
  await refused(run,"final_private_a","b",{operation_id:"getAssetInfo",path:{id:assetId(run,"sharing_private_a")}},400);
  await refused(run,"final_private_b","a",{operation_id:"getAssetInfo",path:{id:assetId(run,"sharing_b")}},400);
}
export async function createSharingFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,SHARING_PLAN);
    try{
      if(!run.revalidate){
        run.state.data={assets:{},album:{},activities:{},baseline:{a:{},b:{}}};run.save();
        for(const actor of ["a","b"] as const)for(const direction of ["shared-by","shared-with"] as const)await partners(run,"baseline_"+actor+"_"+direction.replace("-","_"),actor,direction,undefined,true);
        await upload(run);await seedAlbumActivities(run);await seedPartnersDownloads(run);
      }
      await verifySharing(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"sharing_fixtures_revalidated":"sharing_fixtures_ready",execution_scope:run.state.execution_scope,synthetic_assets:4,retained_albums:1,retained_activities:2,remaining_fixture_partner_directions:0,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Sharing completion is committed; repeat only existing reads and report publication");
      try{run.fail(error);await run.publish();}catch{/* Keep durable mutation receipts. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing sharing fixtures no longer match their assertions; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","Sharing setup did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
