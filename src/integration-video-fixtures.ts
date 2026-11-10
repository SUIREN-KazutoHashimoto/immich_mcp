import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticVideo,mp4Boxes,assertVideoInit,assertVideoFragment,parseVideoMaster,parseVideoPlaylist } from "./integration-video-media.js";
import { FIXTURE_DATE } from "./integration-media.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

export const VIDEO_PLAN="video_fixtures_v1";
type Check=(condition:unknown,id:string)=>void;
type Role="a"|"b";
const roles:Role[]=["a","b"],digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
async function success(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(result:any,check:Check)=>void|Promise<void>){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},verify);
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
async function bytes(run:IntegrationRun,actor:FixtureRole,result:any){
  const p=run.context.actors[actor].principal,stored=run.context.vault.get(p,result.result_ref,"result");
  return readDecoded(run.context.vault.rawStream(p,stored.raw.raw_ref),stored.raw.content_encoding??"identity",16*1024*1024);
}
async function config(run:IntegrationRun,id:string,expected?:any){
  let raw:any;
  await success(run,id,"admin",{operation_id:"getAdminConfig"},200,false,["admin_config"],async(result,check)=>{
    raw=JSON.parse((await bytes(run,"admin",result)).toString("utf8"));
    check(!!raw.ffmpeg?.realtime&&(!expected||isDeepStrictEqual(raw,expected)),"admin_config");
  });return raw;
}
function configCall(run:IntegrationRun,value:any){
  const body=structuredClone(value),values:Record<string,string>={};
  const pointers=["/oauth/clientSecret","/notifications/smtp/transport/password"];
  for(const pointer of pointers){
    const keys=pointer.slice(1).split("/"),last=keys.pop()!;let node=body;
    for(const key of keys){if(!node||typeof node!=="object"||!Object.hasOwn(node,key))integrationFailure("fixture_config","Missing fixed admin configuration field");node=node[key];}
    if(typeof node[last]!=="string")integrationFailure("fixture_config","Expected a protected configuration string");
    values[pointer]=node[last];delete node[last];
  }
  return run.protect("admin",{operation_id:"updateAdminConfig",body},values);
}
async function updateConfig(run:IntegrationRun,id:string,value:any){
  await success(run,id,"admin",configCall(run,value),200,true,["exact_configuration"],async(result,check)=>{
    check(isDeepStrictEqual(JSON.parse((await bytes(run,"admin",result)).toString("utf8")),value),"exact_configuration");
  });
}
function metadataReady(data:any,video:ReturnType<typeof syntheticVideo>){
  return data.type==="VIDEO"&&Number.isInteger(data.duration)&&Math.abs(data.duration-video.durationMs)<=600&&
    data.exifInfo?.exifImageWidth===video.width&&data.exifInfo?.exifImageHeight===video.height;
}
async function waitMetadata(run:IntegrationRun,role:Role){
  const asset=run.state.data.assets[role],video=syntheticVideo(run.context.lab.state.id,role);
  for(let attempt=0;attempt<60;attempt++){
    let ready=false;
    await success(run,"metadata_poll_"+role+"_"+attempt,role,{operation_id:"getAssetInfo",path:{id:asset.id}},200,false,["known_asset"],(result,check)=>{
      check(result.data.id===asset.id&&result.data.ownerId===run.context.actors[role].user_id&&result.data.checksum===video.sha1,"known_asset");
      ready=metadataReady(result.data,video);
    });
    if(ready)return;
    if(attempt<59)await delay(2000);
  }
  integrationFailure("fixture_metadata_timeout","Synthetic video metadata did not become ready; no mutation is replayed");
}
async function readAsset(run:IntegrationRun,id:string,actor:FixtureRole,role:Role){
  const asset=run.state.data.assets[role],video=syntheticVideo(run.context.lab.state.id,role);
  await success(run,id,actor,{operation_id:"getAssetInfo",path:{id:asset.id}},200,false,["video_identity","video_metadata"],(result,check)=>{
    const data=result.data;check(data.id===asset.id&&data.ownerId===run.context.actors[role].user_id&&data.originalFileName===video.filename&&data.checksum===video.sha1,"video_identity");
    check(metadataReady(data,video),"video_metadata");
  });
}
function mp4(bytes:Buffer){const types=mp4Boxes(bytes).map(box=>box.type);return types.includes("ftyp")&&types.includes("moov")&&types.includes("mdat");}
async function capturePlayback(run:IntegrationRun,role:Role){
  let original:Buffer|undefined;
  await success(run,"playback_baseline_"+role,role,{operation_id:"playAssetVideo",path:{id:run.state.data.assets[role].id}},200,false,["playback_container","disabled_transcode_original"],async(result,check)=>{
    original=await bytes(run,role,result);check(result.upstream.content_type==="video/mp4"&&mp4(original),"playback_container");
    check(original.equals(syntheticVideo(run.context.lab.state.id,role).bytes),"disabled_transcode_original");
  });
  run.state.data.playback[role]={base64:original!.toString("base64"),sha256:digest(original!)};run.save();
}
async function verifyVideo(run:IntegrationRun){
  for(const role of roles){
    const id=run.state.data.assets[role].id,video=syntheticVideo(run.context.lab.state.id,role),baseline=Buffer.from(run.state.data.playback[role].base64,"base64");
    await readAsset(run,"owner_video_"+role,role,role);
    await success(run,"original_"+role,role,{operation_id:"downloadAsset",path:{id}},200,false,["exact_original","original_digest"],async(result,check)=>{
      const actual=await bytes(run,role,result);check(actual.equals(video.bytes),"exact_original");check(digest(actual)===video.sha256,"original_digest");
    });
    await success(run,"original_range_"+role,role,{operation_id:"downloadAsset",path:{id},headers:{range:"bytes=8-71"}},206,false,["original_range_bytes","original_content_range"],async(result,check)=>{
      check((await bytes(run,role,result)).equals(video.bytes.subarray(8,72)),"original_range_bytes");
      check(result.upstream.headers["content-range"]==="bytes 8-71/"+video.bytes.length,"original_content_range");
    });
    await success(run,"playback_full_"+role,role,{operation_id:"playAssetVideo",path:{id}},200,false,["playback_stable","playback_container"],async(result,check)=>{
      const actual=await bytes(run,role,result);check(actual.equals(baseline)&&digest(actual)===run.state.data.playback[role].sha256,"playback_stable");
      check(result.upstream.content_type==="video/mp4"&&mp4(actual),"playback_container");
    });
    for(const suffix of [false,true]){
      const range=suffix?"bytes=-32":"bytes=8-71",expected=suffix?baseline.subarray(-32):baseline.subarray(8,72),
        contentRange=suffix?"bytes "+(baseline.length-32)+"-"+(baseline.length-1)+"/"+baseline.length:"bytes 8-71/"+baseline.length;
      await success(run,"playback_"+(suffix?"suffix_":"range_")+role,role,{operation_id:"playAssetVideo",path:{id},headers:{range}},206,false,["playback_range_bytes","playback_content_range"],async(result,check)=>{
        check((await bytes(run,role,result)).equals(expected),"playback_range_bytes");check(result.upstream.headers["content-range"]===contentRange,"playback_content_range");
      });
    }
    await refused(run,"playback_unsatisfiable_"+role,role,{operation_id:"playAssetVideo",path:{id},headers:{range:"bytes="+(baseline.length+10)+"-"}},404);
  }
  const id=run.state.data.assets.a.id;
  await refused(run,"other_video_refused","b",{operation_id:"getAssetInfo",path:{id}},400);
  await refused(run,"other_original_refused","b",{operation_id:"downloadAsset",path:{id}},400);
  await refused(run,"other_playback_refused","b",{operation_id:"playAssetVideo",path:{id}},400);
  await readAsset(run,"restricted_video_metadata","restricted","a");
  await refused(run,"restricted_playback_refused","restricted",{operation_id:"playAssetVideo",path:{id}},403);
}
async function hls(run:IntegrationRun){
  const id=run.state.data.assets.a.id;
  await refused(run,"restricted_hls_refused","restricted",{operation_id:"getMainPlaylist",path:{id}},403,true);
  await refused(run,"other_hls_refused","b",{operation_id:"getMainPlaylist",path:{id}},400,true);
  let variant:ReturnType<typeof parseVideoMaster>[number]|undefined,playlist:ReturnType<typeof parseVideoPlaylist>|undefined;
  await success(run,"hls_main","a",{operation_id:"getMainPlaylist",path:{id}},200,true,["hls_master","h264_variant"],async(result,check)=>{
    const all=parseVideoMaster((await bytes(run,"a",result)).toString("utf8"));check(result.upstream.content_type==="application/vnd.apple.mpegurl"&&all.length===1,"hls_master");
    variant=all.find(value=>value.variantIndex===2&&value.codecs.split(",")[0]?.startsWith("avc1."));
    check(!!variant,"h264_variant");
  });
  run.state.data.hls={session_id:variant!.sessionId,variant_index:variant!.variantIndex,end_acknowledged:false};run.save();
  const path={id,sessionId:variant!.sessionId,variantIndex:variant!.variantIndex};
  await success(run,"hls_media","a",{operation_id:"getMediaPlaylist",path,headers:{"x-immich-hls-pos":0}},200,true,["hls_vod","hls_duration"],async(result,check)=>{
    playlist=parseVideoPlaylist((await bytes(run,"a",result)).toString("utf8"));check(result.upstream.content_type==="application/vnd.apple.mpegurl","hls_vod");
    check(Math.abs(playlist.duration-syntheticVideo(run.context.lab.state.id,"a").durationMs/1000)<0.7,"hls_duration");
  });
  await success(run,"hls_init","a",{operation_id:"getSegment",path:{...path,filename:playlist!.init},headers:{"x-immich-hls-msn":0}},200,true,["hls_init_container"],async(result,check)=>{
    assertVideoInit(await bytes(run,"a",result));check(result.upstream.content_type==="video/mp4","hls_init_container");
  });
  for(const [index,segment] of playlist!.segments.entries()){
    await success(run,"hls_segment_"+index,"a",{operation_id:"getSegment",path:{...path,filename:segment.filename},headers:{"x-immich-hls-msn":index}},200,true,["hls_fragment_container"],async(result,check)=>{
      assertVideoFragment(await bytes(run,"a",result));check(result.upstream.content_type==="video/mp4","hls_fragment_container");
    });
  }
  await refused(run,"other_segment_refused","b",{operation_id:"getSegment",path:{...path,filename:playlist!.segments[0]!.filename}},400,true);
  await success(run,"hls_end","a",{operation_id:"endSession",path:{id,sessionId:path.sessionId}},204,true,["end_acknowledged"],(result,check)=>check(result.upstream.status===204,"end_acknowledged"));
  run.state.data.hls.end_acknowledged=true;run.save();
}
async function seed(run:IntegrationRun){
  run.state.data={assets:{},playback:{}};run.save();
  const before=await config(run,"original_admin_config");run.state.data.original_config=before;run.save();
  const active=structuredClone(before);active.ffmpeg.realtime={enabled:true,resolutions:[480],videoCodecs:["h264"]};
  // Disable background playback conversion for this dedicated fixture, so the
  // full-file baseline and subsequent Range requests select the same artifact.
  active.ffmpeg.transcode="disabled";
  await updateConfig(run,"enable_fixture_hls",active);await config(run,"active_admin_config",active);
  for(const role of roles){
    const video=syntheticVideo(run.context.lab.state.id,role),p=run.context.actors[role].principal;
    const file=await run.staging.ingest(p,video.filename,video.mime,(async function*(){yield video.bytes;})(),video.bytes.length,undefined,video.sha256);
    const uploaded=await success(run,"upload_video_"+role,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:video.filename,fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,isFavorite:false,visibility:"timeline"}},201,true,["created_video"],(result,check)=>{
        check(result.data.status==="created"&&typeof result.data.id==="string","created_video");
      });
    run.state.data.assets[role]={id:uploaded.data.id,sha256:video.sha256,sha1:video.sha1};run.save();
  }
  for(const role of roles){await waitMetadata(run,role);await capturePlayback(run,role);}
  await verifyVideo(run);await hls(run);
  await config(run,"before_restore_admin_config",active);
  await updateConfig(run,"restore_admin_config",before);
}
export async function createVideoFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,VIDEO_PLAN);
    try{
      if(!run.revalidate)await seed(run);else await verifyVideo(run);
      await config(run,"restored_admin_config",run.state.data.original_config);
      run.finish();const report=await run.publish();
      return {state:run.revalidate?"video_fixtures_revalidated":"video_fixtures_ready",execution_scope:run.state.execution_scope,synthetic_videos:2,report,
        hls_end_acknowledged:run.state.data.hls.end_acknowledged,hls_worker_cleanup_verified:false,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Video completion is committed; retry only non-mutating revalidation and publication");
      try{run.fail(error);await run.publish();}catch{/* Keep the original sent receipt and encrypted configuration snapshot. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing video fixtures failed validation; no HLS or configuration operation was replayed");
      return integrationFailure("fixture_recovery_required","Video fixture setup did not finish; preserve the original configuration and receipts in this disposable run");
    }
  },options);
}
