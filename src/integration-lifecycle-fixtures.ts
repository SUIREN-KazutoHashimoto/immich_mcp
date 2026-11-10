import { randomUUID,createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto } from "./integration-media.js";
import { profileImageFrame } from "./integration-profile-image.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

// Dedicated synthetic lab; every sent effect keeps its durable receipt.
export const LIFECYCLE_PLAN="lifecycle_fixtures_v1";
const variants=["lifecycle_a1","lifecycle_a2","lifecycle_a3","lifecycle_a4","lifecycle_a5","lifecycle_a6","lifecycle_b1","lifecycle_b2"] as const;
type Variant=typeof variants[number];type Role="a"|"b";type Check=(ok:unknown,id:string)=>void;
const owner=(v:Variant):Role=>v.startsWith("lifecycle_b")?"b":"a";
const id=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v].id;
const ids=(run:IntegrationRun,vs:readonly Variant[])=>vs.map(v=>id(run,v));
const user=(run:IntegrationRun,role:FixtureRole)=>run.context.actors[role].user_id;
const equal=(a:string[],b:string[])=>isDeepStrictEqual(a.toSorted(),b.toSorted());
const created=(v:Variant)=>new Date(Date.UTC(2022,4,6,7,variants.indexOf(v))).toISOString();
const withSidecar=(v:Variant)=>["lifecycle_a1","lifecycle_a5","lifecycle_a6"].includes(v);
const ownVariants=(role:Role)=>variants.filter(v=>owner(v)===role);
async function json(run:IntegrationRun,key:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void|Promise<void>){
  return run.execute({id:key,actor,call,status,mutates,kind:"success",assertions},(r,c)=>verify(r.data,c));
}
async function ack(run:IntegrationRun,key:string,actor:FixtureRole,call:ApiCall){
  return json(run,key,actor,call,204,true,["acknowledgement"],(_r,c)=>c(true,"acknowledgement"));
}
async function refused(run:IntegrationRun,key:string,actor:FixtureRole,call:ApiCall,status:number,mutates=false){
  return run.execute({id:key,actor,call,status,kind:"refusal",mutates,assertions:["upstream_refusal"]},(r,c)=>c(r.upstream.status===status,"upstream_refusal"));
}
function identity(run:IntegrationRun,v:Variant,data:any){
  const p=syntheticPhoto(run.context.lab.state.id,v);
  return data.id===id(run,v)&&data.ownerId===user(run,owner(v))&&data.checksum===p.sha1&&data.originalFileName===p.filename;
}
async function asset(run:IntegrationRun,key:string,v:Variant,fields:Record<string,unknown>={},expectedTags?:string[],exif:Record<string,unknown>={}){
  const assertions=["owned_asset","asset_fields",...(expectedTags?["asset_tags"]:[]),...(Object.keys(exif).length?["asset_exif"]:[])];
  return json(run,key,owner(v),{operation_id:"getAssetInfo",path:{id:id(run,v)}},200,false,assertions,(data,c)=>{
    c(identity(run,v,data),"owned_asset");
    c(Object.entries(fields).every(([k,value])=>data[k]===value),"asset_fields");
    if(expectedTags)c(Array.isArray(data.tags)&&equal(data.tags.map((t:any)=>t.id),expectedTags),"asset_tags");
    if(Object.keys(exif).length)c(Object.entries(exif).every(([k,value])=>data.exifInfo?.[k]===value),"asset_exif");
  });
}
async function queue(run:IntegrationRun,key:string,name:string,paused?:boolean){
  return json(run,key,"admin",{operation_id:"getQueue",path:{name}},200,false,["queue_identity","queue_statistics"],(data,c)=>{
    c(data.name===name&&(paused===undefined||data.isPaused===paused),"queue_identity");
    c(["active","completed","failed","delayed","waiting","paused"].every(k=>Number.isSafeInteger(data.statistics[k])&&data.statistics[k]>=0),"queue_statistics");
  });
}
async function waitQueue(run:IntegrationRun,key:string,name:string,paused:boolean,drained=false){
  for(let attempt=0;attempt<20;attempt++){
    const r=await queue(run,key+"_"+attempt,name,paused),s=r.data.statistics;
    if(s.active===0&&(!drained||s.waiting===0&&s.delayed===0&&s.paused===0))return;
    if(attempt<19)await delay(1000);
  }
  integrationFailure("fixture_queue_timeout","A required queue did not reach its bounded observation state");
}
async function settleMetadata(run:IntegrationRun,key:string){
  // Sidecar writes enqueue metadata extraction; its source=sidecar-write does not
  // recursively enqueue another sidecar write. Each call retains an exact200.
  await waitQueue(run,key+"_sidecar","sidecar",false,true);
  await waitQueue(run,key+"_metadata","metadataExtraction",false,true);
}
async function preflight(run:IntegrationRun){
  if(run.context.vault.db.prepare("SELECT id FROM records WHERE principal=? AND kind='fixture_run' AND id!=? LIMIT 1").get("__integration_feature_runs",LIFECYCLE_PLAN))
    integrationFailure("fixture_pristine_lab","Lifecycle tests require a separately bootstrapped lab without other feature histories");
  for(const role of ["admin","a","b"] as const)for(const visibility of ["timeline","archive","hidden","locked"])for(const isTrashed of [false,true]){
    await json(run,"baseline_"+role+"_"+visibility+"_"+(isTrashed?"trash":"normal"),"admin",
      {operation_id:"getUserStatisticsAdmin",path:{id:user(run,role)},query:{visibility,isTrashed}},200,false,["no_owned_assets"],
      (data,c)=>c(data.total===0&&data.images===0&&data.videos===0,"no_owned_assets"));
  }
  for(const role of ["a","b"] as const)for(const direction of ["shared-by","shared-with"]){
    await json(run,"baseline_partners_"+role+"_"+direction.replace("-","_"),role,{operation_id:"getPartners",query:{direction}},200,false,["no_partners"],
      (data,c)=>c(Array.isArray(data)&&data.length===0,"no_partners"));
  }
  await json(run,"baseline_trash_configuration","admin",{operation_id:"getConfig"},200,false,["trash_enabled"],
    (data,c)=>c(data.trash.enabled===true&&data.trash.days>=1,"trash_enabled"));
  for(const name of ["backgroundTask","sidecar","metadataExtraction","thumbnailGeneration"]){
    await queue(run,"baseline_queue_"+name.toLowerCase(),name,false);
  }
  const original=await queue(run,"baseline_duplicate_queue","duplicateDetection");
  run.state.data.original_duplicate_pause=original.data.isPaused;run.save();
}
async function pauseDuplicates(run:IntegrationRun){
  await json(run,"pause_duplicate_queue","admin",{operation_id:"updateQueue",path:{name:"duplicateDetection"},body:{isPaused:true}},200,true,
    ["pause_ack"],(data,c)=>c(data.name==="duplicateDetection"&&data.isPaused===true,"pause_ack"));
  await waitQueue(run,"duplicate_pause_readback","duplicateDetection",true);
}
async function upload(run:IntegrationRun){
  for(const v of variants){
    const role=owner(v),p=syntheticPhoto(run.context.lab.state.id,v),principal=run.context.actors[role].principal;
    const file=await run.staging.ingest(principal,p.filename,p.mime,(async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
    const sidecar=withSidecar(v)?await run.staging.ingest(principal,p.filename+".xmp","application/rdf+xml",(async function*(){yield p.sidecar;})(),
      p.sidecar.length,undefined,p.sidecarSha256):undefined;
    const r=await json(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",
      files:{assetData:{file_ref:file.file_ref},...(sidecar?{sidecarData:{file_ref:sidecar.file_ref}}:{})},
      body:{...(sidecar?{}:{filename:p.filename}),fileCreatedAt:created(v),fileModifiedAt:created(v),visibility:"timeline",isFavorite:false}},
      201,true,["new_upload"],(data,c)=>c(data.status==="created"&&typeof data.id==="string","new_upload"));
    run.state.data.assets[v]={id:r.data.id};run.save();
  }
  // Two bounded bulk observations check every uploaded identity, date and EXIF
  // dimension/size. This covers the same eight images without160 single polls.
  for(const role of ["a","b"] as const){
    let ready=false;const expected=ownVariants(role);
    for(let attempt=0;attempt<20;attempt++){
      await json(run,"metadata_"+role+"_"+attempt,role,{operation_id:"searchAssets",body:{size:1000,withExif:true}},200,false,["owned_known_rows"],(data,c)=>{
        const rows=data.assets?.items;
        c(Array.isArray(rows)&&rows.every((a:any)=>expected.some(v=>identity(run,v,a)))&&new Set(rows.map((a:any)=>a.id)).size===rows.length,"owned_known_rows");
        ready=rows.length===expected.length&&expected.every(v=>{
          const a=rows.find((a:any)=>a.id===id(run,v)),p=syntheticPhoto(run.context.lab.state.id,v);
          return a?.fileCreatedAt===created(v)&&a.exifInfo?.exifImageWidth===64&&a.exifInfo?.exifImageHeight===32&&a.exifInfo?.fileSizeInByte===p.bytes.length;
        });
      });
      if(ready)break;if(attempt<19)await delay(1000);
    }
    if(!ready)integrationFailure("fixture_metadata_timeout","All synthetic image identities/dimensions did not become ready; uploads are never replayed");
  }
}
async function createAlbum(run:IntegrationRun,key:string,vs:Variant[],shared=false){
  const name="MCP lifecycle "+key+" "+run.context.lab.state.id;
  const r=await json(run,"create_album_"+key,"a",{operation_id:"createAlbum",body:{albumName:name}},201,true,["owned_album"],
    (data,c)=>c(typeof data.id==="string"&&data.albumName===name&&data.albumUsers.some((u:any)=>u.user.id===user(run,"a")&&u.role==="owner"),"owned_album"));
  run.state.data.albums[key]=r.data.id;run.save();
  const requested=ids(run,vs);
  await json(run,"add_album_"+key,"a",{operation_id:"addAssetsToAlbum",path:{id:r.data.id},body:{ids:requested}},200,true,["exact_additions"],
    (data,c)=>c(data.length===requested.length&&data.every((x:any,i:number)=>x.id===requested[i]&&x.success===true),"exact_additions"));
  if(shared)await json(run,"share_album_"+key,"a",{operation_id:"addUsersToAlbum",path:{id:r.data.id},body:{albumUsers:[{userId:user(run,"b"),role:"viewer"}]}},200,true,
    ["viewer_added"],(data,c)=>c(data.albumUsers.some((u:any)=>u.user.id===user(run,"b")&&u.role==="viewer"),"viewer_added"));
}
async function albumAssets(run:IntegrationRun,key:string,role:Role,album:string,expected:Variant[]){
  return json(run,key,role,{operation_id:"searchAssets",body:{albumIds:[album],size:1000,withExif:true}},200,false,["exact_album_assets"],(data,c)=>
    c(Array.isArray(data.assets?.items)&&equal(data.assets.items.map((a:any)=>a.id),ids(run,expected))&&
      data.assets.items.every((a:any)=>expected.some(v=>identity(run,v,a))),"exact_album_assets"));
}

const selectedFileFields=(f:any)=>({id:f.id,type:f.type,path:f.path,isEdited:f.isEdited,isProgressive:f.isProgressive,isTransparent:f.isTransparent});
async function fileSearch(run:IntegrationRun,key:string,actor:FixtureRole,v:Variant,query:Record<string,any>,expectedIds?:string[]){
  return json(run,key,actor,{operation_id:"searchAssetFiles",query:{assetId:id(run,v),...query}},200,false,["file_rows"],(data,c)=>{
    c(Array.isArray(data)&&new Set(data.map((f:any)=>f.id)).size===data.length&&data.every((f:any)=>typeof f.path==="string"&&f.path.length>0)&&
      (expectedIds===undefined||equal(data.map((f:any)=>f.id),expectedIds)),"file_rows");
  });
}
async function discoverFiles(run:IntegrationRun,key:string,role:Role,v:Variant){
  for(let attempt=0;attempt<20;attempt++){
    const r=await fileSearch(run,"discover_files_"+key+"_"+attempt,role,v,{}),rows=r.data;
    const preview=rows.find((f:any)=>f.type==="preview"&&!f.isEdited),thumbnail=rows.find((f:any)=>f.type==="thumbnail"&&!f.isEdited),
      sidecar=rows.find((f:any)=>f.type==="sidecar");
    if(preview&&thumbnail&&(!withSidecar(v)||sidecar)){
      run.state.data.files[key+"_preview"]=selectedFileFields(preview);
      run.state.data.files[key+"_thumbnail"]=selectedFileFields(thumbnail);
      if(sidecar)run.state.data.files[key+"_sidecar"]=selectedFileFields(sidecar);
      run.save();return;
    }
    if(attempt<19)await delay(1000);
  }
  integrationFailure("fixture_file_timeout","Expected synthetic derivative/sidecar rows did not become ready");
}
async function fileMetadata(run:IntegrationRun,key:string,actor:FixtureRole,fileKey:string){
  const expected=run.state.data.files[fileKey];
  return json(run,key,actor,{operation_id:"getAssetFile",path:{id:expected.id}},200,false,["file_metadata"],
    (data,c)=>c(Object.entries(selectedFileFields(expected)).every(([k,v])=>data[k]===v),"file_metadata"));
}
async function fileBytes(run:IntegrationRun,key:string,actor:FixtureRole,fileKey:string,record=false,sidecarVariant?:Variant,differentFrom?:string){
  const expected=run.state.data.files[fileKey],assertions=[sidecarVariant?"exact_sidecar":"image_frame","file_bytes",...(differentFrom?["different_fixture_bytes"]:[])];
  return run.execute({id:key,actor,call:{operation_id:"downloadAssetFile",path:{id:expected.id}},status:200,kind:"success",mutates:false,assertions},async(result,c)=>{
    const p=run.context.actors[actor].principal,stored=run.context.vault.get(p,result.result_ref,"result"),
      bytes=await readDecoded(run.context.vault.rawStream(p,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024),
      hash=createHash("sha256").update(bytes).digest("hex"),mime=result.upstream.content_type;
    if(sidecarVariant)c(hash===syntheticPhoto(run.context.lab.state.id,sidecarVariant).sidecarSha256&&
      ["application/rdf+xml","application/xml","application/octet-stream"].includes(mime),"exact_sidecar");
    else{const frame=profileImageFrame(bytes,mime);c(frame.width===64&&frame.height===32&&["jpeg","webp"].includes(frame.format),"image_frame");}
    c(record?bytes.length>0:hash===expected.sha256&&mime===expected.mime,"file_bytes");
    if(differentFrom)c(hash!==differentFrom,"different_fixture_bytes");
    if(record){expected.sha256=hash;expected.mime=mime;expected.size=bytes.length;
      expected.range_sha256=createHash("sha256").update(bytes.subarray(2,18)).digest("hex");run.save();}
  });
}
async function fileRange(run:IntegrationRun,key:string,actor:FixtureRole,fileKey:string){
  const expected=run.state.data.files[fileKey];
  return run.execute({id:key,actor,call:{operation_id:"downloadAssetFile",path:{id:expected.id},headers:{Range:"bytes=2-17"}},
    status:206,kind:"success",mutates:false,assertions:["exact_range_bytes","range_metadata"]},async(result,c)=>{
    const principal=run.context.actors[actor].principal,stored=run.context.vault.get(principal,result.result_ref,"result"),
      bytes=await readDecoded(run.context.vault.rawStream(principal,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024);
    c(bytes.length===16&&createHash("sha256").update(bytes).digest("hex")===expected.range_sha256,"exact_range_bytes");
    const headers=result.upstream.headers;
    c(result.upstream.content_type===expected.mime&&headers["content-range"]==="bytes 2-17/"+expected.size&&
      headers["accept-ranges"]==="bytes"&&headers["content-length"]==="16","range_metadata");
  });
}
async function seedFiles(run:IntegrationRun){
  const d=run.state.data;
  await discoverFiles(run,"a","a","lifecycle_a1");
  await discoverFiles(run,"b","b","lifecycle_b1");
  for(const [key,role] of [["a_preview","a"],["a_thumbnail","a"],["a_sidecar","a"],["b_preview","b"]] as const)
    await fileMetadata(run,"file_metadata_"+key,role,key);
  await fileSearch(run,"filtered_preview","a","lifecycle_a1",{type:"preview",isEdited:false,isProgressive:d.files.a_preview.isProgressive,isTransparent:false},[d.files.a_preview.id]);
  await fileSearch(run,"opposite_progressive_filter","a","lifecycle_a1",{type:"preview",isProgressive:!d.files.a_preview.isProgressive},[]);
  await fileSearch(run,"transparent_filter","a","lifecycle_a1",{type:"preview",isTransparent:true},[]);
  await fileSearch(run,"edited_filter","a","lifecycle_a1",{type:"preview",isEdited:true},[]);
  await fileBytes(run,"download_a_preview","a","a_preview",true);
  await fileBytes(run,"download_b_preview","b","b_preview",true,undefined,d.files.a_preview.sha256);
  await fileBytes(run,"download_a_thumbnail","a","a_thumbnail",true);
  await fileBytes(run,"download_sidecar","a","a_sidecar",true,"lifecycle_a1");
  await fileRange(run,"range_a_preview","a","a_preview");
  await fileRange(run,"range_b_preview","b","b_preview");
  await refused(run,"unsatisfiable_file_range","a",{operation_id:"downloadAssetFile",path:{id:d.files.a_preview.id},headers:{Range:"bytes="+(d.files.a_preview.size+1)+"-"}},404);
  await createAlbum(run,"shared",["lifecycle_a1","lifecycle_a2"],true);
  await fileSearch(run,"album_viewer_file_search","b","lifecycle_a1",{type:"preview"},[d.files.a_preview.id]);
  await refused(run,"album_viewer_file_metadata_refused","b",{operation_id:"getAssetFile",path:{id:d.files.a_preview.id}},400);
  await refused(run,"album_viewer_file_download_refused","b",{operation_id:"downloadAssetFile",path:{id:d.files.a_preview.id}},400);
  await refused(run,"foreign_file_delete_refused","a",{operation_id:"deleteAssetFile",path:{id:d.files.b_preview.id}},400,true);
  await refused(run,"sidecar_delete_refused","a",{operation_id:"deleteAssetFile",path:{id:d.files.a_sidecar.id}},400,true);
  await fileMetadata(run,"sidecar_refusal_preserves_metadata","a","a_sidecar");
  await fileBytes(run,"sidecar_refusal_preserves_bytes","a","a_sidecar",false,"lifecycle_a1");
  await ack(run,"delete_owned_preview","a",{operation_id:"deleteAssetFile",path:{id:d.files.a_preview.id}});
  await fileSearch(run,"deleted_preview_search_readback","a","lifecycle_a1",{type:"preview"},[]);
  await refused(run,"deleted_preview_metadata_absent","a",{operation_id:"getAssetFile",path:{id:d.files.a_preview.id}},400);
  await refused(run,"deleted_preview_download_absent","a",{operation_id:"downloadAssetFile",path:{id:d.files.a_preview.id}},400);
}

async function update(run:IntegrationRun,key:string,v:Variant,body:Record<string,any>){
  return json(run,key,owner(v),{operation_id:"updateAsset",path:{id:id(run,v)},body},200,true,["updated_asset"],
    (data,c)=>c(data.id===id(run,v)&&data.ownerId===user(run,owner(v)),"updated_asset"));
}
async function seedMergeMetadata(run:IntegrationRun){
  const d=run.state.data;
  for(const key of ["keep","source"]){
    const name="MCP lifecycle "+key+" "+run.context.lab.state.id;
    const r=await json(run,"create_tag_"+key,"a",{operation_id:"createTag",body:{name}},201,true,["created_tag"],
      (data,c)=>c(typeof data.id==="string"&&data.name===name,"created_tag"));d.tags[key]=r.data.id;run.save();
    const v:Variant=key==="keep"?"lifecycle_a5":"lifecycle_a6";
    await json(run,"tag_"+key,"a",{operation_id:"tagAssets",path:{id:r.data.id},body:{ids:[id(run,v)]}},200,true,["tag_assignment"],
      (data,c)=>c(data.length===1&&data[0].id===id(run,v)&&data[0].success===true,"tag_assignment"));
  }
  await update(run,"keeper_metadata","lifecycle_a5",{description:"Keep line",rating:1,isFavorite:false,visibility:"timeline"});
  await update(run,"source_metadata","lifecycle_a6",{description:"Source line\nKeep line",rating:4,isFavorite:true,visibility:"archive"});
  await settleMetadata(run,"initial_merge_metadata");
  await asset(run,"keeper_metadata_readback","lifecycle_a5",{isFavorite:false,visibility:"timeline",isTrashed:false},[d.tags.keep],{description:"Keep line",rating:1});
  await asset(run,"source_metadata_readback","lifecycle_a6",{isFavorite:true,visibility:"archive",isTrashed:false},[d.tags.source],{description:"Source line\nKeep line",rating:4});
  await createAlbum(run,"merge",["lifecycle_a6"]);
}
async function assignGroup(run:IntegrationRun,key:string,role:Role,vs:Variant[]){
  const group=run.state.data.groups[key];
  await ack(run,"assign_group_"+key,role,{operation_id:"updateAssets",body:{ids:ids(run,vs),duplicateId:group}});
  for(const v of vs)await asset(run,"assigned_"+key+"_"+v,v,{duplicateId:group,isTrashed:false});
}
type GroupExpectation={key:string;members:Variant[]};
async function groups(run:IntegrationRun,key:string,role:Role,expected:GroupExpectation[]){
  const d=run.state.data;
  // The source cleans singleton groups before listing. This GET is a mutation.
  return json(run,key,role,{operation_id:"getAssetDuplicates"},200,true,["exact_duplicate_groups","max_size_suggestions"],(data,c)=>{
    c(Array.isArray(data)&&data.length===expected.length&&new Set(data.map((g:any)=>g.duplicateId)).size===data.length&&expected.every(e=>{
      const g=data.find((g:any)=>g.duplicateId===d.groups[e.key]);
      return g&&Array.isArray(g.assets)&&equal(g.assets.map((a:any)=>a.id),ids(run,e.members))&&g.assets.every((a:any)=>
        e.members.some(v=>identity(run,v,a)&&a.duplicateId===g.duplicateId&&!a.isTrashed&&a.exifInfo?.fileSizeInByte===syntheticPhoto(run.context.lab.state.id,v).bytes.length));
    }),"exact_duplicate_groups");
    c(data.every((g:any)=>{
      const e=expected.find(e=>d.groups[e.key]===g.duplicateId)!;
      const maximum=Math.max(...e.members.map(v=>syntheticPhoto(run.context.lab.state.id,v).bytes.length));
      const candidates=e.members.filter(v=>syntheticPhoto(run.context.lab.state.id,v).bytes.length===maximum);
      return Array.isArray(g.suggestedKeepAssetIds)&&g.suggestedKeepAssetIds.length===1&&ids(run,candidates).includes(g.suggestedKeepAssetIds[0]);
    }),"max_size_suggestions");
  });
}
const groupRequest=(duplicateId:string,keepAssetIds:string[],trashAssetIds:string[])=>({duplicateId,keepAssetIds,trashAssetIds});
async function resolve(run:IntegrationRun,key:string,body:any[],ok:boolean,error?:string){
  const group=run.state.data.groups.resolve;
  return json(run,key,"a",{operation_id:"resolveDuplicates",body:{groups:body}},200,true,["resolution_result"],
    (data,c)=>c(Array.isArray(data)&&data.length===1&&data[0].id===group&&data[0].success===ok&&(ok?!data[0].error:data[0].error===error),"resolution_result"));
}
async function duplicateWorkflows(run:IntegrationRun){
  const d=run.state.data,g=d.groups;
  const single:Variant[]=["lifecycle_a1","lifecycle_a2"],bulk:Variant[]=["lifecycle_a3","lifecycle_a4"],
    merge:Variant[]=["lifecycle_a5","lifecycle_a6"],foreign:Variant[]=["lifecycle_b1","lifecycle_b2"];
  await assignGroup(run,"single","a",single);await assignGroup(run,"bulk","a",bulk);await assignGroup(run,"resolve","a",merge);await assignGroup(run,"b","b",foreign);
  await groups(run,"initial_a_groups","a",[{key:"single",members:single},{key:"bulk",members:bulk},{key:"resolve",members:merge}]);
  await groups(run,"initial_b_groups","b",[{key:"b",members:foreign}]);
  await refused(run,"foreign_group_single_delete","a",{operation_id:"deleteDuplicate",path:{id:g.b}},400,true);
  await refused(run,"mixed_group_bulk_delete","a",{operation_id:"deleteDuplicates",body:{ids:[g.bulk,g.b]}},400,true);
  for(const v of bulk)await asset(run,"bulk_refusal_owned_"+v,v,{duplicateId:g.bulk,isTrashed:false});
  for(const v of foreign)await asset(run,"bulk_refusal_foreign_"+v,v,{duplicateId:g.b,isTrashed:false});
  await ack(run,"dismiss_single_group","a",{operation_id:"deleteDuplicate",path:{id:g.single}});
  for(const v of single)await asset(run,"single_dismissed_"+v,v,{duplicateId:null,isTrashed:false});
  await assignGroup(run,"second_bulk","a",single);
  await groups(run,"reseeded_bulk_groups","a",[{key:"second_bulk",members:single},{key:"bulk",members:bulk},{key:"resolve",members:merge}]);
  await ack(run,"dismiss_multiple_groups","a",{operation_id:"deleteDuplicates",body:{ids:[g.second_bulk,g.bulk]}});
  for(const v of [...single,...bulk])await asset(run,"bulk_dismissed_"+v,v,{duplicateId:null,isTrashed:false});
  await assignGroup(run,"singleton","a",["lifecycle_a4"]);
  await groups(run,"list_cleans_singleton","a",[{key:"resolve",members:merge}]);
  await asset(run,"singleton_cleanup_readback","lifecycle_a4",{duplicateId:null,isTrashed:false});
  await asset(run,"singleton_cleanup_keeps_b","lifecycle_b1",{duplicateId:g.b,isTrashed:false});
  const a5=id(run,"lifecycle_a5"),a6=id(run,"lifecycle_a6"),b1=id(run,"lifecycle_b1"),b2=id(run,"lifecycle_b2");
  await resolve(run,"reject_overlapping_resolution",[groupRequest(g.resolve,[a5],[a5,a6])],false,"validation");
  await resolve(run,"reject_incomplete_resolution",[groupRequest(g.resolve,[a5],[])],false,"validation");
  for(const v of merge)await asset(run,"invalid_resolution_preserves_"+v,v,{duplicateId:g.resolve,isTrashed:false});
  await refused(run,"mixed_owner_resolution_refused","a",{operation_id:"resolveDuplicates",body:{groups:[
    groupRequest(g.resolve,[a5],[a6]),groupRequest(g.b,[b1],[b2])]}},400,true);
  for(const v of merge)await asset(run,"mixed_resolution_preserves_"+v,v,{duplicateId:g.resolve,isTrashed:false});
  for(const v of foreign)await asset(run,"mixed_resolution_preserves_"+v,v,{duplicateId:g.b,isTrashed:false});
  // Foreign IDs not in the owned group are ignored by this fixed service.
  await resolve(run,"resolve_owned_group",[groupRequest(g.resolve,[a5,b1],[a6,b2])],true);
  await settleMetadata(run,"resolved_merge_metadata");
  await asset(run,"merged_keeper_readback","lifecycle_a5",{isFavorite:true,visibility:"archive",isTrashed:false,duplicateId:null},
    [d.tags.keep,d.tags.source],{description:"Keep line\nSource line",rating:4});
  await asset(run,"resolved_source_trashed","lifecycle_a6",{isFavorite:true,visibility:"archive",isTrashed:true,duplicateId:null});
  await albumAssets(run,"resolved_album_keeper","a",d.albums.merge,["lifecycle_a5"]);
  for(const v of foreign)await asset(run,"foreign_resolution_ids_ignored_"+v,v,{duplicateId:g.b,isTrashed:false,isFavorite:false});
  await groups(run,"owned_groups_dismissed","a",[]);
  await groups(run,"foreign_group_still_owned","b",[{key:"b",members:foreign}]);
  await ack(run,"dismiss_b_group","b",{operation_id:"deleteDuplicates",body:{ids:[g.b]}});
  for(const v of foreign)await asset(run,"b_group_dismissed_"+v,v,{duplicateId:null,isTrashed:false});
}

async function trashCount(run:IntegrationRun,key:string,role:Role,call:ApiCall,count:number){
  return json(run,key,role,call,200,true,["trash_count"],(data,c)=>c(data.count===count,"trash_count"));
}
async function stats(run:IntegrationRun,key:string,role:Role,visibility:string,isTrashed:boolean,count:number){
  return json(run,key,"admin",{operation_id:"getUserStatisticsAdmin",path:{id:user(run,role)},query:{visibility,isTrashed}},200,false,["owned_statistics"],
    (data,c)=>c(data.total===count&&data.images===count&&data.videos===0,"owned_statistics"));
}
async function trashWorkflows(run:IntegrationRun){
  const a6=id(run,"lifecycle_a6"),b2=id(run,"lifecycle_b2");
  await ack(run,"trash_foreign_b2","b",{operation_id:"deleteAssets",body:{ids:[b2],force:false}});
  await asset(run,"b2_trashed_readback","lifecycle_b2",{isTrashed:true});
  await refused(run,"mixed_owner_restore_refused","a",{operation_id:"restoreAssets",body:{ids:[a6,b2]}},400,true);
  await asset(run,"mixed_restore_preserves_a","lifecycle_a6",{isTrashed:true});
  await asset(run,"mixed_restore_preserves_b","lifecycle_b2",{isTrashed:true});
  await trashCount(run,"restore_selected_a","a",{operation_id:"restoreAssets",body:{ids:[a6]}},1);
  await asset(run,"selected_restore_readback","lifecycle_a6",{isTrashed:false});
  await asset(run,"selected_restore_keeps_b_trashed","lifecycle_b2",{isTrashed:true});
  await ack(run,"trash_two_a","a",{operation_id:"deleteAssets",body:{ids:ids(run,["lifecycle_a4","lifecycle_a6"]),force:false}});
  await asset(run,"whole_restore_before_a4","lifecycle_a4",{isTrashed:true});
  await asset(run,"whole_restore_before_a6","lifecycle_a6",{isTrashed:true});
  await trashCount(run,"restore_all_a","a",{operation_id:"restoreTrash"},2);
  await asset(run,"whole_restore_readback_a4","lifecycle_a4",{isTrashed:false});
  await asset(run,"whole_restore_readback_a6","lifecycle_a6",{isTrashed:false});
  await asset(run,"whole_restore_keeps_b_trashed","lifecycle_b2",{isTrashed:true});
  await ack(run,"trash_permanent_candidate","a",{operation_id:"deleteAssets",body:{ids:[a6],force:false}});
  await stats(run,"trash_candidate_before_empty","a","archive",true,1);
  await trashCount(run,"empty_a_trash","a",{operation_id:"emptyTrash"},1);
  // Trashed statistics omit status=deleted rows even before physical cleanup.
  await stats(run,"empty_trash_marked_deleted","a","archive",true,0);
  await asset(run,"empty_trash_preserves_b","lifecycle_b2",{isTrashed:true});
  // The fixed source awaits enqueueing AssetEmptyTrash and its AssetDelete
  // children. Both use backgroundTask and have no priority override.
  await waitQueue(run,"empty_trash_background","backgroundTask",false,true);
  await refused(run,"deleted_asset_api_absent","a",{operation_id:"getAssetInfo",path:{id:a6}},400);
  await trashCount(run,"restore_all_b","b",{operation_id:"restoreTrash"},1);
  await asset(run,"restore_b_readback","lifecycle_b2",{isTrashed:false});
}
function scopeCalls(run:IntegrationRun):{call:ApiCall;mutates:boolean}[]{
  const d=run.state.data,a6=id(run,"lifecycle_a6");
  return [
    {call:{operation_id:"searchAssetFiles",query:{assetId:id(run,"lifecycle_a1")}},mutates:false},
    {call:{operation_id:"getAssetFile",path:{id:d.files.a_thumbnail.id}},mutates:false},
    {call:{operation_id:"downloadAssetFile",path:{id:d.files.a_thumbnail.id},headers:{Range:"bytes=2-17"}},mutates:false},
    {call:{operation_id:"deleteAssetFile",path:{id:d.files.a_thumbnail.id}},mutates:true},
    {call:{operation_id:"getAssetDuplicates"},mutates:true},
    {call:{operation_id:"deleteDuplicate",path:{id:d.groups.resolve}},mutates:true},
    {call:{operation_id:"deleteDuplicates",body:{ids:[d.groups.resolve]}},mutates:true},
    {call:{operation_id:"resolveDuplicates",body:{groups:[groupRequest(d.groups.resolve,[id(run,"lifecycle_a5")],[])]}},mutates:true},
    {call:{operation_id:"restoreAssets",body:{ids:[a6]}},mutates:true},
    {call:{operation_id:"restoreTrash"},mutates:true},
    {call:{operation_id:"emptyTrash"},mutates:true}
  ];
}
async function verifyScopes(run:IntegrationRun){
  for(const {call,mutates} of scopeCalls(run)){
    if(run.revalidate&&mutates)continue;
    await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403,mutates);
  }
  await refused(run,"nonadmin_queue_refused","a",{operation_id:"getQueue",path:{name:"duplicateDetection"}},403);
}
async function restoreDuplicateQueue(run:IntegrationRun){
  const paused=run.state.data.original_duplicate_pause;
  if(!paused)await json(run,"restore_duplicate_queue","admin",{operation_id:"updateQueue",path:{name:"duplicateDetection"},body:{isPaused:false}},200,true,
    ["resume_ack"],(data,c)=>c(data.name==="duplicateDetection"&&data.isPaused===false,"resume_ack"));
  await queue(run,"restored_duplicate_queue","duplicateDetection",paused);
}
async function verifyLifecycle(run:IntegrationRun){
  const d=run.state.data;
  // Automatic duplicate jobs may assign new IDs after the queue is restored.
  // Final repeat assertions deliberately concern the stable owned state.
  for(const v of variants.filter(v=>v!=="lifecycle_a6")){
    if(v==="lifecycle_a5")await asset(run,"final_"+v,v,{isTrashed:false,isFavorite:true,visibility:"archive"},
      [d.tags.keep,d.tags.source],{description:"Keep line\nSource line",rating:4});
    else await asset(run,"final_"+v,v,{isTrashed:false,isFavorite:false,visibility:"timeline"});
  }
  await refused(run,"final_deleted_asset","a",{operation_id:"getAssetInfo",path:{id:id(run,"lifecycle_a6")}},400);
  await fileMetadata(run,"final_a_thumbnail_metadata","a","a_thumbnail");
  await fileMetadata(run,"final_b_preview_metadata","b","b_preview");
  await fileMetadata(run,"final_sidecar_metadata","a","a_sidecar");
  await fileBytes(run,"final_a_thumbnail_bytes","a","a_thumbnail");
  await fileBytes(run,"final_b_preview_bytes","b","b_preview");
  await fileBytes(run,"final_sidecar_bytes","a","a_sidecar",false,"lifecycle_a1");
  await fileRange(run,"final_a_thumbnail_range","a","a_thumbnail");
  await fileRange(run,"final_b_preview_range","b","b_preview");
  await refused(run,"final_shared_file_range_refused","b",{operation_id:"downloadAssetFile",path:{id:d.files.a_thumbnail.id},headers:{Range:"bytes=2-17"}},400);
  await fileSearch(run,"final_deleted_preview_search","a","lifecycle_a1",{type:"preview"},[]);
  await refused(run,"final_deleted_file","a",{operation_id:"getAssetFile",path:{id:d.files.a_preview.id}},400);
  await refused(run,"final_shared_file_metadata_refused","b",{operation_id:"getAssetFile",path:{id:d.files.a_thumbnail.id}},400);
  await fileSearch(run,"final_shared_file_search","b","lifecycle_a1",{type:"thumbnail"},[d.files.a_thumbnail.id]);
  await albumAssets(run,"final_shared_album_assets","b",d.albums.shared,["lifecycle_a1","lifecycle_a2"]);
  await albumAssets(run,"final_merged_album_assets","a",d.albums.merge,["lifecycle_a5"]);
  await refused(run,"final_private_merge_album","b",{operation_id:"getAlbumInfo",path:{id:d.albums.merge}},400);
  await stats(run,"final_a_timeline","a","timeline",false,4);
  await stats(run,"final_a_archive","a","archive",false,1);
  await stats(run,"final_b_timeline","b","timeline",false,2);
  for(const role of ["a","b"] as const)for(const visibility of ["timeline","archive"])
    await stats(run,"final_trash_"+role+"_"+visibility,role,visibility,true,0);
  await queue(run,"final_duplicate_queue","duplicateDetection",d.original_duplicate_pause);
  await verifyScopes(run);
}
export async function createLifecycleFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,LIFECYCLE_PLAN,{maxCases:448});
    try{
      if(!run.revalidate){
        run.state.data={assets:{},files:{},albums:{},tags:{},groups:Object.fromEntries(
          ["single","bulk","resolve","b","second_bulk","singleton"].map(key=>[key,randomUUID()]))};run.save();
        await preflight(run);await pauseDuplicates(run);await upload(run);await seedFiles(run);await seedMergeMetadata(run);
        await duplicateWorkflows(run);await trashWorkflows(run);await restoreDuplicateQueue(run);
      }
      await verifyLifecycle(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"lifecycle_fixtures_revalidated":"lifecycle_fixtures_ready",execution_scope:run.state.execution_scope,
        created_synthetic_assets:8,retained_synthetic_assets:7,retained_albums:2,retained_tags:2,deleted_asset_api_absence:"observed",
        physical_deletion_verified:false,machine_learning_duplicate_detection_verified:false,report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Lifecycle completion is committed; retry only read-only validation and report publication");
      try{run.fail(error);await run.publish();}catch{/* Keep durable sent and completion evidence. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Owned lifecycle state changed; no mutations or cleanup GETs were replayed");
      return integrationFailure("fixture_recovery_required","Lifecycle setup did not finish; preserve evidence and prepare a new dedicated lab");
    }
  },options);
}
