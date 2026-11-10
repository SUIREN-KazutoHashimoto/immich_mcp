import { createHash } from "node:crypto";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto,FIXTURE_DATE } from "./integration-media.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

export const MEDIA_PLAN="media_fixtures_v1";
type Variant="a"|"private_a"|"b";
const variants:Variant[]=["a","private_a","b"];
const owner=(variant:Variant):FixtureRole=>variant==="b"?"b":"a";
const photos=(run:IntegrationRun)=>Object.fromEntries(variants.map(v=>[v,syntheticPhoto(run.context.lab.state.id,v)])) as Record<Variant,ReturnType<typeof syntheticPhoto>>;
type Check=(condition:unknown,id:string)=>void;
async function success(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check,result:any)=>void|Promise<void>){
  return run.execute({id,actor,call,status,kind:"success",mutates,assertions},(result,check)=>verify(result.data,check,result));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,kind:"refusal",mutates,assertions:["expected_refusal"]},(result,check)=>check(result.upstream?.status===status,"expected_refusal"));
}
async function binary(run:IntegrationRun,id:string,actor:FixtureRole,assetId:string,expected:Buffer){
  return success(run,id,actor,{operation_id:"downloadAsset",path:{id:assetId}},200,false,["exact_original_bytes","original_sha256"],async(_data,check,result)=>{
    const p=run.context.actors[actor].principal,stored=run.context.vault.get(p,result.result_ref,"result");
    const bytes=await readDecoded(run.context.vault.rawStream(p,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024);
    check(bytes.equals(expected),"exact_original_bytes");
    check(createHash("sha256").update(bytes).digest("hex")===createHash("sha256").update(expected).digest("hex"),"original_sha256");
  });
}
async function readAsset(run:IntegrationRun,id:string,actor:FixtureRole,variant:Variant){
  const fixture=run.state.data.assets[variant],photo=syntheticPhoto(run.context.lab.state.id,variant),user=run.context.actors[owner(variant)];
  return success(run,id,actor,{operation_id:"getAssetInfo",path:{id:fixture.id}},200,false,["asset_identity","asset_owner","asset_sha1","original_name","favorite_flag"],(data,check)=>{
    check(data.id===fixture.id,"asset_identity");check(data.ownerId===user.user_id,"asset_owner");check(data.checksum===photo.sha1,"asset_sha1");
    check(data.originalFileName===photo.filename,"original_name");check(data.isFavorite===(variant==="a"&&run.context.actors[actor].user_id===user.user_id),"favorite_flag");
  });
}
async function album(run:IntegrationRun,id:string,actor:FixtureRole,key:"private"|"shared",shared:boolean){
  const expected=run.state.data.albums[key];
  return success(run,id,actor,{operation_id:"getAlbumInfo",path:{id:expected.id}},200,false,["album_identity","album_name","asset_count","owner_membership",...(shared?["viewer_membership"]:[])],(data,check)=>{
    check(data.id===expected.id,"album_identity");check(data.albumName===expected.name,"album_name");check(data.assetCount===1,"asset_count");
    check(data.albumUsers?.[0]?.user.id===run.context.actors.a.user_id&&data.albumUsers[0].role==="owner","owner_membership");
    if(shared)check(data.albumUsers.some((item:any)=>item.user.id===run.context.actors.b.user_id&&item.role==="viewer"),"viewer_membership");
  });
}
async function verifyMedia(run:IntegrationRun){
  const fixture=run.state.data,media=photos(run);
  await success(run,"server_version","admin",{operation_id:"getServerVersion"},200,false,["fixed_version"],(data,check)=>check(data.major===3&&data.minor===3&&data.patch===5&&data.prerelease===null,"fixed_version"));
  for(const role of ["a","b"] as const)await success(run,"user_identity_"+role,role,{operation_id:"getMyUser"},200,false,["caller_identity","non_admin"],(data,check)=>{
    check(data.id===run.context.actors[role].user_id,"caller_identity");check(data.isAdmin===false,"non_admin");
  });
  await success(run,"own_key_list","a",{operation_id:"getApiKeys"},200,false,["own_keys_only"],(data,check)=>{
    const ids=data.map((key:any)=>key.id).sort(),expected=[run.context.actors.a.key_id,run.context.actors.restricted.key_id].sort();
    check(JSON.stringify(ids)===JSON.stringify(expected),"own_keys_only");
  });
  for(const variant of variants){
    await readAsset(run,"owner_asset_"+variant,owner(variant),variant);
    await binary(run,"owner_original_"+variant,owner(variant),fixture.assets[variant].id,media[variant].bytes);
  }
  await album(run,"owner_private_album","a","private",false);
  await album(run,"owner_shared_album","a","shared",true);
  await album(run,"viewer_shared_album","b","shared",true);
  await readAsset(run,"viewer_shared_asset","b","a");
  await binary(run,"viewer_shared_original","b",fixture.assets.a.id,media.a.bytes);
  await refused(run,"private_album_refused","b",{operation_id:"getAlbumInfo",path:{id:fixture.albums.private.id}},400);
  await refused(run,"private_asset_refused","b",{operation_id:"getAssetInfo",path:{id:fixture.assets.private_a.id}},400);
  await refused(run,"private_original_refused","b",{operation_id:"downloadAsset",path:{id:fixture.assets.private_a.id}},400);
  await readAsset(run,"restricted_owner_asset","restricted","private_a");
  await refused(run,"restricted_download_refused","restricted",{operation_id:"downloadAsset",path:{id:fixture.assets.private_a.id}},403);
  await success(run,"album_asset_membership","a",{operation_id:"getAllAlbums",query:{assetId:fixture.assets.private_a.id}},200,false,["private_album_membership","shared_album_exclusion"],(data,check)=>{
    check(data.some((item:any)=>item.id===fixture.albums.private.id),"private_album_membership");
    check(data.every((item:any)=>item.id!==fixture.albums.shared.id),"shared_album_exclusion");
  });
  await success(run,"own_tag","a",{operation_id:"getTagById",path:{id:fixture.tag.id}},200,false,["tag_identity","tag_name"],(data,check)=>{
    check(data.id===fixture.tag.id,"tag_identity");check(data.name===fixture.tag.name,"tag_name");
  });
  await success(run,"tagged_asset","a",{operation_id:"getAssetInfo",path:{id:fixture.assets.private_a.id}},200,false,["tag_assignment"],(data,check)=>check(data.tags?.some((tag:any)=>tag.id===fixture.tag.id),"tag_assignment"));
  await success(run,"tag_list","a",{operation_id:"getAllTags"},200,false,["tag_present"],(data,check)=>check(data.some((tag:any)=>tag.id===fixture.tag.id),"tag_present"));
  await success(run,"other_tag_list","b",{operation_id:"getAllTags"},200,false,["tag_isolated"],(data,check)=>check(data.every((tag:any)=>tag.id!==fixture.tag.id),"tag_isolated"));
  await refused(run,"other_tag_refused","b",{operation_id:"getTagById",path:{id:fixture.tag.id}},400);
}
async function seedMedia(run:IntegrationRun){
  const media=photos(run);run.state.data={assets:{},albums:{}};run.save();
  for(const variant of variants){
    const role=owner(variant),p=run.context.actors[role].principal,photo=media[variant];
    const file=await run.staging.ingest(p,photo.filename,photo.mime,(async function*(){yield photo.bytes;})(),photo.bytes.length,undefined,photo.sha256);
    const sidecar=variant==="a"?await run.staging.ingest(p,photo.filename+".xmp","application/rdf+xml",(async function*(){yield photo.sidecar;})(),photo.sidecar.length,undefined,photo.sidecarSha256):undefined;
    const files:any={assetData:{file_ref:file.file_ref},...(sidecar?{sidecarData:{file_ref:sidecar.file_ref}}:{})};
    const call:ApiCall={operation_id:"uploadAsset",content_type:"multipart/form-data",files,body:{...(sidecar?{}:{filename:photo.filename}),fileCreatedAt:FIXTURE_DATE,fileModifiedAt:FIXTURE_DATE,isFavorite:variant==="a",visibility:"timeline"}};
    const uploaded=await success(run,"upload_"+variant,role,call,201,true,["new_upload"],(data,check)=>check(data.status==="created"&&typeof data.id==="string","new_upload"));
    run.state.data.assets[variant]={id:uploaded.data.id,file_ref:file.file_ref,sidecar_ref:sidecar?.file_ref,sha256:photo.sha256,sha1:photo.sha1,size:photo.bytes.length};run.save();
    if(variant==="a")await success(run,"deliberate_duplicate",role,call,200,true,["duplicate_same_asset"],(data,check)=>check(data.status==="duplicate"&&data.id===uploaded.data.id,"duplicate_same_asset"));
  }
  const data=run.state.data;
  await readAsset(run,"owner_before_share","a","a");
  await readAsset(run,"other_owner_before_share","b","b");
  await refused(run,"unshared_asset_refused","b",{operation_id:"getAssetInfo",path:{id:data.assets.a.id}},400);
  await refused(run,"restricted_album_create_refused","restricted",{operation_id:"createAlbum",body:{albumName:"must-be-refused-"+run.context.lab.state.id}},403,true);
  for(const kind of ["private","shared"] as const){
    const name="MCP "+kind+" "+run.context.lab.state.id,created=await success(run,"create_album_"+kind,"a",{operation_id:"createAlbum",body:{albumName:name,description:null}},201,true,
      ["new_album","empty_album"],(data,check)=>{check(data.albumName===name&&data.albumUsers?.[0]?.user.id===run.context.actors.a.user_id,"new_album");check(data.assetCount===0,"empty_album");});
    data.albums[kind]={id:created.data.id,name};run.save();
    const asset=data.assets[kind==="private"?"private_a":"a"].id;
    await success(run,"add_album_asset_"+kind,"a",{operation_id:"addAssetsToAlbum",path:{id:created.data.id},body:{ids:[asset]}},200,true,["asset_added"],(value,check)=>{
      check(Array.isArray(value)&&value.length===1&&value[0].id===asset&&value[0].success===true&&!value[0].error,"asset_added");
    });
  }
  await refused(run,"unshared_album_refused","b",{operation_id:"getAlbumInfo",path:{id:data.albums.shared.id}},400);
  await success(run,"share_album_viewer","a",{operation_id:"addUsersToAlbum",path:{id:data.albums.shared.id},body:{albumUsers:[{userId:run.context.actors.b.user_id,role:"viewer"}]}},200,true,
    ["viewer_added"],(value,check)=>check(value.albumUsers.some((item:any)=>item.user.id===run.context.actors.b.user_id&&item.role==="viewer"),"viewer_added"));
  const name="MCP tag "+run.context.lab.state.id,tag=await success(run,"create_tag","a",{operation_id:"createTag",body:{name,color:"#336699",parentId:null}},201,true,["tag_created"],(value,check)=>check(value.name===name&&typeof value.id==="string","tag_created"));
  data.tag={id:tag.data.id,name};run.save();
  const asset=data.assets.private_a.id;
  await success(run,"assign_tag","a",{operation_id:"tagAssets",path:{id:tag.data.id},body:{ids:[asset]}},200,true,["tag_assigned"],(value,check)=>{
    check(Array.isArray(value)&&value.length===1&&value[0].id===asset&&value[0].success===true&&!value[0].error,"tag_assigned");
  });
}
export async function createFeatureFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,MEDIA_PLAN);
    try{
      if(!run.revalidate)await seedMedia(run);
      await verifyMedia(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"fixtures_revalidated":"fixtures_ready",execution_scope:run.state.execution_scope,synthetic_assets:3,albums:2,tags:1,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Feature completion is committed; retry only read-only revalidation and report publication");
      try{run.fail(error);await run.publish();}catch{/* The original started/sent receipt continues to fence mutation replay. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing feature fixtures no longer match their assertions; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","Feature setup did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
