import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto } from "./integration-media.js";
import { profileImageFrame } from "./integration-profile-image.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

export const PEOPLE_PLAN="people_fixtures_v1";
const variants=["people_a1","people_a2","people_b1"] as const;
type Variant=typeof variants[number];type Role="a"|"b";
type Check=(condition:unknown,id:string)=>void;
const owner=(v:Variant):Role=>v==="people_b1"?"b":"a";
const asset=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v];
const user=(run:IntegrationRun,role:FixtureRole)=>run.context.actors[role].user_id;
const exact=(actual:string[],expected:string[])=>isDeepStrictEqual(actual.toSorted(),expected.toSorted());
const date="2022-05-06T07:08:09.000Z";
const personFields=(data:any,expected:Record<string,unknown>)=>Object.entries(expected).every(([k,v])=>data[k]===v);

async function json(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void|Promise<void>){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},(result,check)=>verify(result.data,check));
}
async function ack(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status=204){
  return json(run,id,actor,call,status,true,["acknowledgement"],(_data,check)=>check(true,"acknowledgement"));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id,actor,call,status,mutates,kind:"refusal",assertions:["upstream_refusal"]},(result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
async function person(run:IntegrationRun,id:string,actor:FixtureRole,personId:string,expected:Record<string,unknown>){
  return json(run,id,actor,{operation_id:"getPerson",path:{id:personId}},200,false,["person_identity","person_fields"],(data,check)=>{
    check(data.id===personId,"person_identity");check(personFields(data,expected),"person_fields");
  });
}
async function statistics(run:IntegrationRun,id:string,actor:FixtureRole,personId:string,count:number){
  return json(run,id,actor,{operation_id:"getPersonStatistics",path:{id:personId}},200,false,["distinct_assets"],(data,check)=>check(data.assets===count,"distinct_assets"));
}
async function members(run:IntegrationRun,id:string,actor:FixtureRole,group:string,roles:FixtureRole[]){
  return json(run,id,actor,{operation_id:"getClusterGroupUsers",path:{id:group}},200,false,["exact_members","caller_first"],(data,check)=>{
    check(Array.isArray(data)&&exact(data.map((u:any)=>u.id),roles.map(role=>user(run,role))),"exact_members");
    check(!roles.includes(actor)||data[0]?.id===user(run,actor),"caller_first");
  });
}
async function requests(run:IntegrationRun,id:string,actor:FixtureRole,group:string|undefined,expected:any[]){
  return json(run,id,actor,group?{operation_id:"getClusterGroupRequestsForGroup",path:{id:group}}:{operation_id:"getClusterGroupRequests"},200,false,
    ["exact_requests"],(data,check)=>check(Array.isArray(data)&&data.length===expected.length&&data.every((r:any)=>expected.some(e=>personFields(r,e))),"exact_requests"));
}
async function people(run:IntegrationRun,id:string,actor:FixtureRole,query:Record<string,any>,expected:string[],total:number,hidden:number,hasNextPage=false){
  return json(run,id,actor,{operation_id:"getAllPeople",query},200,false,["exact_people","people_counts"],(data,check)=>{
    check(Array.isArray(data.people)&&exact(data.people.map((p:any)=>p.id),expected),"exact_people");
    check(data.total===total&&data.hidden===hidden&&data.hasNextPage===hasNextPage,"people_counts");
  });
}
async function search(run:IntegrationRun,id:string,actor:FixtureRole,name:string,expected:string[],withHidden=true){
  return json(run,id,actor,{operation_id:"searchPerson",query:{name,withHidden}},200,false,["exact_name_matches"],
    (data,check)=>check(Array.isArray(data)&&exact(data.map((p:any)=>p.id),expected),"exact_name_matches"));
}
async function preflight(run:IntegrationRun){
  if(run.context.vault.db.prepare("SELECT id FROM records WHERE principal=? AND kind='fixture_run' AND id!=? LIMIT 1").get("__integration_feature_runs",PEOPLE_PLAN))
    integrationFailure("fixture_pristine_lab","People/cluster tests require a separately bootstrapped lab without other feature runs");
  const d=run.state.data;
  for(const role of ["admin","a","b"] as const){
    const result=await json(run,"baseline_user_"+role,role,{operation_id:"getMyUser"},200,false,["own_cluster"],
      (data,check)=>check(data.id===user(run,role)&&typeof data.clusterGroupId==="string","own_cluster"));
    d.groups[role]=result.data.clusterGroupId;run.save();
    await members(run,"baseline_members_"+role,role,d.groups[role],[role]);
    await requests(run,"baseline_incoming_"+role,role,undefined,[]);
    await requests(run,"baseline_group_requests_"+role,role,d.groups[role],[]);
  }
  if(new Set(Object.values(d.groups)).size!==3)integrationFailure("fixture_pristine_lab","Fresh actors must have separate singleton cluster groups");
  for(const role of ["a","b"] as const){
    await people(run,"baseline_people_"+role,role,{withHidden:true},[],0,0);
    for(const visibility of ["timeline","archive","hidden","locked"])for(const isTrashed of [false,true]){
      await json(run,"baseline_assets_"+role+"_"+visibility+"_"+(isTrashed?"trash":"normal"),"admin",
        {operation_id:"getUserStatisticsAdmin",path:{id:user(run,role)},query:{visibility,isTrashed}},200,false,["zero_assets"],
        (data,check)=>check(data.total===0&&data.images===0&&data.videos===0,"zero_assets"));
    }
  }
}
async function upload(run:IntegrationRun){
  for(const v of variants){
    const role=owner(v),photo=syntheticPhoto(run.context.lab.state.id,v);
    const file=await run.staging.ingest(run.context.actors[role].principal,photo.filename,photo.mime,(async function*(){yield photo.bytes;})(),photo.bytes.length,undefined,photo.sha256);
    const result=await json(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:photo.filename,fileCreatedAt:date,fileModifiedAt:date,visibility:"timeline",isFavorite:false}},201,true,["new_upload"],
      (data,check)=>check(data.status==="created"&&typeof data.id==="string","new_upload"));
    run.state.data.assets[v]=result.data.id;run.save();
  }
  for(const v of variants){
    let ready=false;const photo=syntheticPhoto(run.context.lab.state.id,v);
    for(let attempt=0;attempt<20;attempt++){
      await json(run,"metadata_"+v+"_"+attempt,owner(v),{operation_id:"getAssetInfo",path:{id:asset(run,v)}},200,false,["own_asset"],(data,check)=>{
        check(data.id===asset(run,v)&&data.ownerId===user(run,owner(v))&&data.checksum===photo.sha1&&data.originalFileName===photo.filename,"own_asset");
        ready=data.exifInfo?.exifImageWidth===64&&data.exifInfo?.exifImageHeight===32&&data.exifInfo?.fileSizeInByte===photo.bytes.length;
      });
      if(ready)break;if(attempt<19)await delay(1000);
    }
    if(!ready)integrationFailure("fixture_metadata_timeout","Synthetic face image metadata did not become ready; uploads are never replayed");
  }
}
async function create(run:IntegrationRun,key:string,role:Role,expected:Record<string,any>){
  const result=await json(run,"create_person_"+key,role,{operation_id:"createPerson",body:expected},201,true,["created_person"],
    (data,check)=>check(typeof data.id==="string"&&personFields(data,expected),"created_person"));
  run.state.data.people[key]=result.data.id;run.save();return result.data.id as string;
}
async function update(run:IntegrationRun,id:string,role:Role,personId:string,body:Record<string,any>,expected:Record<string,any>){
  return json(run,id,role,{operation_id:"updatePerson",path:{id:personId},body},200,true,["updated_person"],
    (data,check)=>check(data.id===personId&&personFields(data,expected),"updated_person"));
}
async function face(run:IntegrationRun,key:string,role:Role,v:Variant,personId:string,x:number,y=4,width=20,height=20){
  await ack(run,"create_face_"+key,role,{operation_id:"createFace",body:{assetId:asset(run,v),personId,x,y,width,height,imageWidth:64,imageHeight:32}},201);
  run.state.data.faces[key]={asset:v,person:personId,x,y,width,height};run.save();
}
async function faces(run:IntegrationRun,id:string,actor:FixtureRole,v:Variant,keys:string[],discover=false,personOverride?:Record<string,string|null>){
  return json(run,id,actor,{operation_id:"getFaces",query:{id:asset(run,v)}},200,false,["manual_face_set","face_geometry","face_people"],(data,check)=>{
    const expected=keys.map(key=>({key,...run.state.data.faces[key]})),manual=Array.isArray(data)?data.filter(f=>f.sourceType==="manual"):[];
    check(Array.isArray(data)&&manual.length===expected.length&&(!discover||!run.revalidate)&&expected.every(e=>manual.some(f=>f.boundingBoxX1===e.x&&f.boundingBoxY1===e.y)),"manual_face_set");
    check(expected.every(e=>manual.some(f=>f.imageWidth===64&&f.imageHeight===32&&f.boundingBoxX1===e.x&&f.boundingBoxX2===e.x+e.width&&f.boundingBoxY1===e.y&&f.boundingBoxY2===e.y+e.height&&
      (discover||f.id===e.id)))&&manual.every((f,i)=>i===0||manual[i-1]!.boundingBoxX1<=f.boundingBoxX1),"face_geometry");
    check(expected.every(e=>{
      const f=manual.find(f=>f.boundingBoxX1===e.x&&f.boundingBoxY1===e.y),person=personOverride&&Object.hasOwn(personOverride,e.key)?personOverride[e.key]:e.person;
      return person===null?f?.person===null:f?.person?.id===person;
    }),"face_people");
    if(discover){for(const e of expected)run.state.data.faces[e.key].id=manual.find(f=>f.boundingBoxX1===e.x&&f.boundingBoxY1===e.y)!.id;run.save();}
  });
}
async function thumbnail(run:IntegrationRun,id:string,role:FixtureRole,personId:string,expected?:string){
  let sha256="";
  await run.execute({id,actor:role,call:{operation_id:"getPersonThumbnail",path:{id:personId}},status:200,kind:"success",mutates:false,
    assertions:["jpeg_frame","thumbnail_bytes"]},async(result,check)=>{
    const principal=run.context.actors[role].principal,stored=run.context.vault.get(principal,result.result_ref,"result");
    const bytes=await readDecoded(run.context.vault.rawStream(principal,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024);
    const frame=profileImageFrame(bytes,result.upstream.content_type);sha256=createHash("sha256").update(bytes).digest("hex");
    check(result.upstream.content_type==="image/jpeg"&&frame.width===22&&frame.height===22,"jpeg_frame");
    check(expected===undefined?bytes.length>100:sha256===expected,"thumbnail_bytes");
  });return sha256;
}
async function waitThumbnail(run:IntegrationRun,key:string,role:Role,personId:string,oldHash?:string){
  let hash="";
  for(let attempt=0;attempt<20;attempt++){
    let ready=false;
    await json(run,"thumbnail_ready_"+key+"_"+attempt,role,{operation_id:"getPerson",path:{id:personId}},200,false,["person_identity"],
      (data,check)=>{check(data.id===personId,"person_identity");ready=!!data.thumbnailPath;});
    if(ready){hash=await thumbnail(run,"thumbnail_poll_"+key+"_"+attempt,role,personId);if(!oldHash||hash!==oldHash)break;}
    if(attempt<19)await delay(1000);
  }
  if(!hash||hash===oldHash)integrationFailure("fixture_thumbnail_timeout","The expected face thumbnail did not become ready");
  run.state.data.thumbnails[key]=hash;run.save();return hash;
}

async function seedPeople(run:IntegrationRun){
  const d=run.state.data,suffix=run.context.lab.state.id;
  d.alpha={name:"Alpha "+suffix,birthDate:"2000-01-02",isHidden:false,isFavorite:false,color:"#123456"};
  d.beta={name:"Beta "+suffix,birthDate:"2001-02-03",isHidden:false,isFavorite:false,color:"#654321"};run.save();
  const alpha=await create(run,"alpha","a",d.alpha),zeta=await create(run,"zeta","a",{name:"Zeta "+suffix,birthDate:null,isHidden:true,isFavorite:false}),
    beta=await create(run,"beta","b",d.beta);
  await refused(run,"private_alpha_before_share","b",{operation_id:"getPerson",path:{id:alpha}},400);
  await refused(run,"foreign_person_update","b",{operation_id:"updatePerson",path:{id:alpha},body:{name:"Forbidden"}},400,true);
  await refused(run,"foreign_face_create","b",{operation_id:"createFace",body:{assetId:asset(run,"people_a1"),personId:beta,x:5,y:4,width:20,height:20,imageWidth:64,imageHeight:32}},400,true);
  await face(run,"afirst","a","people_a1",alpha,5);
  await face(run,"azeta","a","people_a1",zeta,36);
  await face(run,"asecond","a","people_a2",zeta,5);
  await face(run,"bfirst","b","people_b1",beta,5);
  await faces(run,"discover_a1","a","people_a1",["afirst","azeta"],true);
  await faces(run,"discover_a2","a","people_a2",["asecond"],true);
  await faces(run,"discover_b1","b","people_b1",["bfirst"],true);
  await statistics(run,"initial_alpha_statistics","a",alpha,1);
  await statistics(run,"initial_zeta_statistics","a",zeta,2);
  await people(run,"people_visible","a",{name:suffix},[alpha],2,1);
  await people(run,"people_hidden","a",{name:suffix,isHidden:true},[zeta],1,1);
  await people(run,"people_page_one","a",{name:suffix,withHidden:true,size:1,page:1},[alpha],2,1,true);
  await people(run,"people_page_two","a",{name:suffix,withHidden:true,size:1,page:2},[zeta],2,1);
  await search(run,"search_alpha","a","Alpha",[alpha]);
  await search(run,"search_hidden_excluded","a","Zeta",[],false);
  await search(run,"search_hidden_included","a","Zeta",[zeta],true);
  await search(run,"search_foreign_alpha","b","Alpha",[]);
  await waitThumbnail(run,"alpha_first","a",alpha);
  await waitThumbnail(run,"beta","b",beta);
  if(d.thumbnails.alpha_first===d.thumbnails.beta)integrationFailure("fixture_assertion","Separate synthetic owners must produce different thumbnail bytes");
  d.alpha={...d.alpha,isFavorite:true,color:"#abcdef"};run.save();
  await update(run,"update_alpha","a",alpha,{isFavorite:true,color:"#abcdef"},d.alpha);
  await person(run,"updated_alpha_readback","a",alpha,d.alpha);
  await update(run,"clear_alpha_color","a",alpha,{color:null},{...d.alpha,color:undefined});
  await person(run,"cleared_color_readback","a",alpha,{...d.alpha,color:undefined});
  await update(run,"restore_alpha_color","a",alpha,{color:d.alpha.color},d.alpha);
  await json(run,"bulk_update_mixed","a",{operation_id:"updatePeople",body:{people:[{id:alpha,isFavorite:false,color:"#000000"},{id:beta,name:"Forbidden"}]}},200,true,
    ["bulk_update_results"],(data,check)=>check(data.length===2&&data[0].id===alpha&&data[0].success===true&&data[1].id===beta&&data[1].success===false&&data[1].error==="unknown","bulk_update_results"));
  // The pinned service forwards favorite/name, but does not forward bulk color.
  await person(run,"bulk_update_readback","a",alpha,{...d.alpha,isFavorite:false});
  await person(run,"bulk_foreign_unchanged","b",beta,d.beta);
  await update(run,"restore_alpha_favorite","a",alpha,{isFavorite:true},d.alpha);
  await people(run,"favorite_people","a",{name:suffix,isFavorite:true},[alpha],1,0);
  await json(run,"reassign_single_face","a",{operation_id:"reassignFacesById",path:{id:alpha},body:{id:d.faces.azeta.id}},200,true,
    ["target_person"],(data,check)=>check(data.id===alpha,"target_person"));
  d.faces.azeta.person=alpha;run.save();
  await faces(run,"single_face_readback","a","people_a1",["afirst","azeta"]);
  await statistics(run,"single_face_distinct_statistics","a",alpha,1);
  await json(run,"reassign_asset_faces","a",{operation_id:"reassignFaces",path:{id:alpha},body:{data:[{personId:zeta,assetId:asset(run,"people_a2")}]}},200,true,
    ["target_people"],(data,check)=>check(data.length===1&&data[0].id===alpha,"target_people"));
  d.faces.asecond.person=alpha;run.save();
  await faces(run,"asset_face_readback","a","people_a2",["asecond"]);
  await statistics(run,"reassigned_statistics","a",alpha,2);
  await json(run,"merge_current","a",{operation_id:"mergePeople",body:{ids:[alpha,zeta]}},200,true,["merged_ids"],(data,check)=>
    check(data.length===2&&data.every((r:any,i:number)=>r.id===[alpha,zeta][i]&&r.success===true&&!r.error),"merged_ids"));
  await refused(run,"merged_zeta_absent","a",{operation_id:"getPerson",path:{id:zeta}},400);
  const legacy=await create(run,"legacy","a",{name:"Legacy "+suffix,birthDate:null,isHidden:false,isFavorite:false});
  await face(run,"legacy","a","people_a1",legacy,24,5,10,10);
  await faces(run,"discover_legacy","a","people_a1",["afirst","azeta","legacy"],true);
  await json(run,"merge_legacy","a",{operation_id:"mergePersonLegacy",path:{id:alpha},body:{ids:[legacy]}},200,true,["merged_ids"],(data,check)=>
    check(data.length===2&&data.every((r:any,i:number)=>r.id===[alpha,legacy][i]&&r.success===true&&!r.error),"merged_ids"));
  d.faces.legacy.person=alpha;run.save();
  await faces(run,"legacy_merge_face_readback","a","people_a1",["afirst","azeta","legacy"]);
  await refused(run,"merged_legacy_absent","a",{operation_id:"getPerson",path:{id:legacy}},400);
  await person(run,"merged_alpha_fields","a",alpha,d.alpha);
  await face(run,"soft","a","people_a1",alpha,1,1,2,2);
  await face(run,"hard","a","people_a1",alpha,60,1,2,2);
  await faces(run,"discover_deleted_faces","a","people_a1",["afirst","azeta","legacy","soft","hard"],true);
  await ack(run,"soft_delete_face","a",{operation_id:"deleteFace",path:{id:d.faces.soft.id},body:{force:false}});
  await faces(run,"soft_delete_readback","a","people_a1",["afirst","azeta","legacy","hard"]);
  await ack(run,"hard_delete_face","a",{operation_id:"deleteFace",path:{id:d.faces.hard.id},body:{force:true}});
  await faces(run,"hard_delete_readback","a","people_a1",["afirst","azeta","legacy"]);
  const bulk1=await create(run,"bulk_one","a",{name:"Bulk one "+suffix}),bulk2=await create(run,"bulk_two","a",{name:"Bulk two "+suffix});
  await refused(run,"bulk_delete_mixed_owners","a",{operation_id:"deletePeople",body:{ids:[bulk1,beta]}},400,true);
  await person(run,"bulk_refusal_preserves_owned","a",bulk1,{name:"Bulk one "+suffix});
  await person(run,"bulk_refusal_preserves_foreign","b",beta,d.beta);
  await ack(run,"bulk_delete_people","a",{operation_id:"deletePeople",body:{ids:[bulk1,bulk2]}});
  for(const [i,p] of [bulk1,bulk2].entries())await refused(run,"bulk_deleted_"+i,"a",{operation_id:"getPerson",path:{id:p}},400);
  await update(run,"feature_face_update","a",alpha,{featureFaceAssetId:asset(run,"people_a2")},d.alpha);
  await waitThumbnail(run,"alpha_final","a",alpha,d.thumbnails.alpha_first);
  if(d.thumbnails.alpha_final===d.thumbnails.beta)integrationFailure("fixture_assertion","Changed feature photo must remain owner-specific");
}
async function invitation(run:IntegrationRun,key:string,recipient:FixtureRole,status=201){
  const d=run.state.data,group=d.groups.a,call:ApiCall={operation_id:"createClusterGroupRequest",path:{id:group},body:{userId:user(run,recipient)}};
  const result=await json(run,"invite_"+key,"a",call,status,true,["request_identity"],(data,check)=>
    check(typeof data.id==="string"&&data.clusterGroupId===group&&data.userId===user(run,recipient)&&typeof data.createdAt==="string","request_identity"));
  d.requests[key]=result.data;run.save();return result.data;
}
async function joinCluster(run:IntegrationRun){
  const d=run.state.data,group=d.groups.a,request=await invitation(run,"b","b");
  await requests(run,"incoming_invite_b","b",undefined,[request]);
  const duplicate=await invitation(run,"b_duplicate","b",200);
  if(!isDeepStrictEqual(request,duplicate))integrationFailure("fixture_assertion","Duplicate invitation must preserve its ID and creation time");
  await requests(run,"outgoing_invite_a","a",group,[request]);
  await members(run,"invitee_can_read_group","b",group,["a"]);
  await refused(run,"outsider_group_read","admin",{operation_id:"getClusterGroupUsers",path:{id:group}},400);
  await refused(run,"invite_self","a",{operation_id:"createClusterGroupRequest",path:{id:group},body:{userId:user(run,"a")}},400,true);
  await refused(run,"outsider_cannot_invite","admin",{operation_id:"createClusterGroupRequest",path:{id:group},body:{userId:user(run,"b")}},400,true);
  await ack(run,"accept_cluster","b",{operation_id:"acceptClusterGroupRequest",path:{id:request.id}});
  await json(run,"joined_user_readback","b",{operation_id:"getMyUser"},200,false,["joined_cluster"],(data,check)=>check(data.id===user(run,"b")&&data.clusterGroupId===group,"joined_cluster"));
  await members(run,"joined_members_a","a",group,["a","b"]);
  await members(run,"joined_members_b","b",group,["a","b"]);
  await requests(run,"joined_request_consumed","b",undefined,[]);
  await refused(run,"consumed_request_not_reaccepted","b",{operation_id:"acceptClusterGroupRequest",path:{id:request.id}},400,true);
  const declined=await invitation(run,"admin_decline","admin");
  await members(run,"admin_invitee_can_read","admin",group,["a","b"]);
  await refused(run,"invitee_cannot_leave","admin",{operation_id:"leaveClusterGroup",path:{id:group}},400,true);
  await ack(run,"recipient_decline","admin",{operation_id:"deleteClusterGroupRequest",path:{id:declined.id}});
  await requests(run,"declined_request_absent","a",group,[]);
  const cancelled=await invitation(run,"admin_cancel","admin");
  await ack(run,"member_cancel_request","b",{operation_id:"deleteClusterGroupRequest",path:{id:cancelled.id}});
  await requests(run,"cancelled_request_absent","admin",undefined,[]);
  await requests(run,"cancelled_group_request_absent","a",group,[]);
}
async function shares(run:IntegrationRun,id:string,role:Role,p:string,expectedRole?:string){
  return json(run,id,role,{operation_id:"getUsersForPeople",query:{personId:p}},200,false,["exact_share_edges"],(data,check)=>{
    check(Array.isArray(data)&&data.length===(expectedRole?1:0)&&(!expectedRole||data[0].personId===p&&data[0].sharedById===user(run,"a")&&data[0].sharedWithId===user(run,"b")&&
      data[0].sharedBy.id===user(run,"a")&&data[0].sharedWith.id===user(run,"b")&&data[0].role===expectedRole),"exact_share_edges");
  });
}
async function share(run:IntegrationRun,id:string,p:string,role:string){
  await ack(run,id,"a",{operation_id:"upsertPeopleUsers",body:{personIds:[p],sharedWithIds:[user(run,"b")],role}},200);
  await shares(run,id+"_readback","a",p,role);
}
async function personSharing(run:IntegrationRun){
  const d=run.state.data,p=d.people.alpha,suffix=run.context.lab.state.id;
  await share(run,"share_read",p,"read");
  d.copy={name:d.alpha.name,birthDate:d.alpha.birthDate,isHidden:false,isFavorite:false};run.save();
  await person(run,"shared_person_copy","b",p,d.copy);
  await statistics(run,"shared_person_without_asset","b",p,0);
  await people(run,"shared_person_not_listed_without_asset","b",{name:"Alpha"},[],0,0);
  await thumbnail(run,"shared_thumbnail_without_album","b",p,d.thumbnails.alpha_final);
  await refused(run,"read_share_cannot_update_owner","b",{operation_id:"updatePerson",path:{id:p},body:{userId:user(run,"a"),name:"Forbidden"}},400,true);
  await refused(run,"read_share_cannot_delete_owner","b",{operation_id:"deletePerson",path:{id:p},body:{userId:user(run,"a")}},400,true);
  const album=await json(run,"create_face_album","a",{operation_id:"createAlbum",body:{albumName:"MCP people "+suffix}},201,true,["owned_album"],
    (data,check)=>check(typeof data.id==="string"&&data.albumUsers.some((u:any)=>u.user.id===user(run,"a")&&u.role==="owner"),"owned_album"));
  d.album=album.data.id;run.save();
  const assetIds=[asset(run,"people_a1"),asset(run,"people_a2")];
  await json(run,"add_face_album_assets","a",{operation_id:"addAssetsToAlbum",path:{id:d.album},body:{ids:assetIds}},200,true,["added_assets"],
    (data,check)=>check(data.length===2&&data.every((r:any,i:number)=>r.id===assetIds[i]&&r.success===true),"added_assets"));
  await json(run,"share_face_album","a",{operation_id:"addUsersToAlbum",path:{id:d.album},body:{albumUsers:[{userId:user(run,"b"),role:"viewer"}]}},200,true,["viewer_added"],
    (data,check)=>check(data.albumUsers.some((u:any)=>u.user.id===user(run,"b")&&u.role==="viewer"),"viewer_added"));
  await faces(run,"shared_geometry_readback","b","people_a1",["afirst","azeta","legacy"]);
  await statistics(run,"shared_person_album_statistics","b",p,2);
  await people(run,"shared_person_now_listed","b",{name:"Alpha"},[p],1,0);
  await share(run,"share_write",p,"write");
  const ownerName="Owner "+suffix;
  await update(run,"write_other_owner_name","b",p,{userId:user(run,"a"),name:ownerName},{...d.alpha,name:ownerName});
  d.alpha.name=ownerName;run.save();
  await person(run,"other_owner_changed","a",p,d.alpha);
  await person(run,"own_copy_unchanged","b",p,d.copy);
  await refused(run,"personal_properties_cannot_override_owner","b",{operation_id:"updatePerson",path:{id:p},body:{userId:user(run,"a"),isFavorite:false,color:"#111111"}},400,true);
  const sharedName="Shared "+suffix;
  await update(run,"write_shared_name","b",p,{name:sharedName,isFavorite:true,color:"#112233"},{...d.copy,name:sharedName,isFavorite:true,color:"#112233"});
  d.alpha.name=sharedName;d.copy={...d.copy,name:sharedName,isFavorite:true,color:"#112233"};run.save();
  await person(run,"propagated_name_owner","a",p,d.alpha);
  await person(run,"personal_fields_copy","b",p,d.copy);
  await share(run,"share_admin",p,"admin");
  const temporary=await create(run,"shared_delete","a",{name:"Delete "+suffix});
  await share(run,"share_delete_admin",temporary,"admin");
  await ack(run,"admin_share_delete_other_owner","b",{operation_id:"deletePerson",path:{id:temporary},body:{userId:user(run,"a")}});
  await refused(run,"deleted_other_owner_absent","a",{operation_id:"getPerson",path:{id:temporary}},400);
  await person(run,"recipient_copy_survives_owner_delete","b",temporary,{name:"Delete "+suffix});
  await ack(run,"delete_recipient_temporary_copy","b",{operation_id:"deletePeople",body:{ids:[temporary]}});
  await refused(run,"recipient_temporary_copy_absent","b",{operation_id:"getPerson",path:{id:temporary}},400);
  await ack(run,"unshare_person","a",{operation_id:"removeUsersFromPeople",body:[{personId:p,sharedWithId:user(run,"b")}]},200);
  await shares(run,"unshared_owner_edges","a",p);
  await shares(run,"unshared_recipient_edges","b",p);
  await person(run,"unshared_recipient_copy_remains","b",p,d.copy);
  await refused(run,"unshared_cannot_update_other_owner","b",{operation_id:"updatePerson",path:{id:p},body:{userId:user(run,"a"),name:"Forbidden"}},400,true);
  await face(run,"bshared","b","people_b1",p,36);
  await faces(run,"discover_b_shared_face","b","people_b1",["bfirst","bshared"],true);
}

function scopeCalls(run:IntegrationRun):{call:ApiCall;mutates:boolean}[]{
  const d=run.state.data,p=d.people.alpha,group=d.groups.a,faceId=d.faces.afirst.id;
  return [
    {call:{operation_id:"getClusterGroupRequests"},mutates:false},
    {call:{operation_id:"getClusterGroupRequestsForGroup",path:{id:group}},mutates:false},
    {call:{operation_id:"getClusterGroupUsers",path:{id:group}},mutates:false},
    {call:{operation_id:"createClusterGroupRequest",path:{id:group},body:{userId:user(run,"b")}},mutates:true},
    {call:{operation_id:"deleteClusterGroupRequest",path:{id:d.requests.b.id}},mutates:true},
    {call:{operation_id:"acceptClusterGroupRequest",path:{id:d.requests.b.id}},mutates:true},
    {call:{operation_id:"leaveClusterGroup",path:{id:group}},mutates:true},
    {call:{operation_id:"clusterGroupRegeneratePeople",path:{id:group}},mutates:true},
    {call:{operation_id:"getFaces",query:{id:asset(run,"people_a1")}},mutates:false},
    {call:{operation_id:"createFace",body:{assetId:asset(run,"people_a1"),personId:p,x:2,y:2,width:4,height:4,imageWidth:64,imageHeight:32}},mutates:true},
    {call:{operation_id:"deleteFace",path:{id:faceId},body:{force:false}},mutates:true},
    {call:{operation_id:"reassignFacesById",path:{id:p},body:{id:faceId}},mutates:true},
    {call:{operation_id:"getAllPeople",query:{withHidden:true}},mutates:false},
    {call:{operation_id:"getPerson",path:{id:p}},mutates:false},
    {call:{operation_id:"getPersonStatistics",path:{id:p}},mutates:false},
    {call:{operation_id:"getPersonThumbnail",path:{id:p}},mutates:false},
    {call:{operation_id:"getUsersForPeople",query:{personId:p}},mutates:false},
    {call:{operation_id:"createPerson",body:{name:"Restricted"}},mutates:true},
    {call:{operation_id:"updatePerson",path:{id:p},body:{isFavorite:false}},mutates:true},
    {call:{operation_id:"updatePeople",body:{people:[{id:p,isFavorite:false}]}},mutates:true},
    {call:{operation_id:"deletePerson",path:{id:p},body:{}},mutates:true},
    {call:{operation_id:"deletePeople",body:{ids:[p]}},mutates:true},
    {call:{operation_id:"mergePeople",body:{ids:[p,d.people.beta]}},mutates:true},
    {call:{operation_id:"mergePersonLegacy",path:{id:p},body:{ids:[d.people.beta]}},mutates:true},
    {call:{operation_id:"reassignFaces",path:{id:p},body:{data:[{personId:p,assetId:asset(run,"people_a1")}]}},mutates:true},
    {call:{operation_id:"upsertPeopleUsers",body:{personIds:[p],sharedWithIds:[user(run,"b")],role:"read"}},mutates:true},
    {call:{operation_id:"removeUsersFromPeople",body:[{personId:p,sharedWithId:user(run,"b")} ]},mutates:true}
  ];
}
async function leaveCluster(run:IntegrationRun){
  const d=run.state.data;
  // This is only a queue acknowledgement. Manual faces do not prove ML inference.
  await ack(run,"regenerate_cluster_ack","a",{operation_id:"clusterGroupRegeneratePeople",path:{id:d.groups.a}});
  await ack(run,"leave_cluster","b",{operation_id:"leaveClusterGroup",path:{id:d.groups.a}});
  const current=await json(run,"left_user_readback","b",{operation_id:"getMyUser"},200,false,["new_singleton_group"],(data,check)=>
    check(data.id===user(run,"b")&&typeof data.clusterGroupId==="string"&&data.clusterGroupId!==d.groups.a&&data.clusterGroupId!==d.groups.b,"new_singleton_group"));
  d.groups.b_final=current.data.clusterGroupId;run.save();
  await json(run,"discover_remapped_person","b",{operation_id:"getFaces",query:{id:asset(run,"people_b1")}},200,false,["owned_face_remapped","solo_face_stable"],(data,check)=>{
    const remapped=data.find((f:any)=>f.id===d.faces.bshared.id),solo=data.find((f:any)=>f.id===d.faces.bfirst.id);
    check(!!remapped?.person&&typeof remapped.person.id==="string"&&remapped.person.id!==d.people.alpha&&personFields(remapped.person,d.copy),"owned_face_remapped");
    check(solo?.person?.id===d.people.beta,"solo_face_stable");
    d.people.remapped=remapped.person.id;d.faces.bshared.person=remapped.person.id;run.save();
  });
}
async function verifyPeople(run:IntegrationRun){
  const d=run.state.data,p=d.people.alpha,b=d.people.beta,copy=d.people.remapped,suffix=run.context.lab.state.id;
  for(const [role,group] of [["a",d.groups.a],["b",d.groups.b_final],["admin",d.groups.admin]] as const){
    await json(run,"final_user_"+role,role,{operation_id:"getMyUser"},200,false,["stable_cluster"],
      (data,check)=>check(data.id===user(run,role)&&data.clusterGroupId===group,"stable_cluster"));
    await members(run,"final_members_"+role,role,group,[role]);
    await requests(run,"final_incoming_"+role,role,undefined,[]);
    await requests(run,"final_requests_"+role,role,group,[]);
  }
  await person(run,"final_alpha","a",p,d.alpha);
  await person(run,"final_beta","b",b,d.beta);
  await person(run,"final_remapped_copy","b",copy,d.copy);
  await statistics(run,"final_alpha_statistics","a",p,2);
  await statistics(run,"final_beta_statistics","b",b,1);
  await statistics(run,"final_copy_statistics","b",copy,1);
  await people(run,"final_a_people","a",{name:suffix,withHidden:true},[p],1,0);
  await people(run,"final_b_people","b",{name:suffix,withHidden:true},[b,copy],2,0);
  await search(run,"final_a_name_search","a","Shared",[p]);
  await search(run,"final_b_name_search","b","Shared",[copy]);
  await search(run,"final_b_beta_search","b","Beta",[b]);
  await faces(run,"final_a1_faces","a","people_a1",["afirst","azeta","legacy"]);
  await faces(run,"final_a2_faces","a","people_a2",["asecond"]);
  await faces(run,"final_b1_faces","b","people_b1",["bfirst","bshared"]);
  await faces(run,"final_shared_geometry_without_person","b","people_a1",["afirst","azeta","legacy"],false,{afirst:null,azeta:null,legacy:null});
  await faces(run,"final_shared_geometry_a2_without_person","b","people_a2",["asecond"],false,{asecond:null});
  await refused(run,"final_foreign_face_asset","a",{operation_id:"getFaces",query:{id:asset(run,"people_b1")}},400);
  await refused(run,"final_foreign_remapped_person","a",{operation_id:"getPerson",path:{id:copy}},400);
  await refused(run,"final_old_recipient_person_absent","b",{operation_id:"getPerson",path:{id:p}},400);
  await shares(run,"final_owner_shares","a",p);
  await shares(run,"final_recipient_shares","b",copy);
  await thumbnail(run,"final_alpha_thumbnail","a",p,d.thumbnails.alpha_final);
  await thumbnail(run,"final_beta_thumbnail","b",b,d.thumbnails.beta);
  await json(run,"final_shared_album","b",{operation_id:"getAlbumInfo",path:{id:d.album}},200,false,["shared_album_members"],(data,check)=>
    check(data.id===d.album&&data.assetCount===2&&data.albumUsers.some((u:any)=>u.user.id===user(run,"a")&&u.role==="owner")&&
      data.albumUsers.some((u:any)=>u.user.id===user(run,"b")&&u.role==="viewer"),"shared_album_members"));
  await json(run,"final_album_assets","b",{operation_id:"searchAssets",body:{albumIds:[d.album],size:10,withExif:false}},200,false,["exact_album_assets"],(data,check)=>
    check(Array.isArray(data.assets?.items)&&exact(data.assets.items.map((a:any)=>a.id),[asset(run,"people_a1"),asset(run,"people_a2")])&&
      data.assets.items.every((a:any)=>a.ownerId===user(run,"a")),"exact_album_assets"));
  for(const {call,mutates} of scopeCalls(run)){
    if(run.revalidate&&mutates)continue;
    await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,mutates);
  }
}
export async function createPeopleFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,PEOPLE_PLAN,{maxCases:384});
    try{
      if(!run.revalidate){
        run.state.data={assets:{},groups:{},people:{},faces:{},requests:{},thumbnails:{}};run.save();
        await preflight(run);await upload(run);await seedPeople(run);await joinCluster(run);await personSharing(run);await leaveCluster(run);
      }
      await verifyPeople(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"people_fixtures_revalidated":"people_fixtures_ready",execution_scope:run.state.execution_scope,
        synthetic_assets:3,retained_named_people:3,retained_visible_manual_faces:6,retained_shared_albums:1,report,
        machine_learning_inference:"not_verified",api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","People completion is committed; retry only read-only revalidation and report publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve durable sent/completion evidence. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Existing people/face/cluster state no longer matches; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","People setup did not finish; preserve evidence and prepare a new dedicated disposable run");
    }
  },options);
}
