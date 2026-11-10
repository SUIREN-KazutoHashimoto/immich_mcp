import { setTimeout as delay } from "node:timers/promises";
import { posix } from "node:path";
import { withInitializedFixtureLab,type FixtureRole } from "./integration-bootstrap.js";
import type { LabOptions } from "./integration-lab.js";
import { IntegrationRun,integrationFailure } from "./integration-run.js";
import { syntheticPhoto } from "./integration-media.js";
import { readDecoded } from "./content-encoding.js";
import type { ApiCall } from "./types.js";

export const DISCOVERY_PLAN="discovery_fixtures_v1";
const variants=["discovery_a_shared","discovery_a_private","discovery_b"] as const;
type Variant=typeof variants[number];type Role="a"|"b";type Check=(condition:unknown,id:string)=>void;
const START="2023-07-01T00:00:00.000Z",END="2023-07-31T23:59:59.999Z",BUCKET="2023-07-01";
const dates=["2023-07-18T01:00:00.000Z","2023-07-18T02:00:00.000Z","2023-07-18T03:00:00.000Z"];
const near=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-6;
const points=[[35.681236,139.767125],[48.8584,2.2945],[35.6895,139.6917]];
const owner=(v:Variant):Role=>v==="discovery_b"?"b":"a";
const assetId=(run:IntegrationRun,v:Variant):string=>run.state.data.assets[v].id;
const photo=(run:IntegrationRun,v:Variant)=>syntheticPhoto(run.context.lab.state.id,v);
const same=(a:string[],b:string[])=>a.length===b.length&&a.toSorted().every((id,i)=>id===b.toSorted()[i]);
const selected=(run:IntegrationRun,vs:readonly Variant[])=>vs.map(v=>assetId(run,v));
const legacy={takenAfter:START,takenBefore:END};
const active={takenAt:{gte:START,lte:END},trashedAt:{eq:null}};
const actorOwner=(actor:FixtureRole)=>actor==="restricted"?"a":actor;
async function json(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number,mutates:boolean,assertions:string[],verify:(data:any,check:Check)=>void){
  return run.execute({id,actor,call,status,mutates,kind:"success",assertions},(result,check)=>verify(result.data,check));
}
async function refused(run:IntegrationRun,id:string,actor:FixtureRole,call:ApiCall,status:number){
  return run.execute({id,actor,call,status,mutates:false,kind:"refusal",assertions:["upstream_refusal"]},
    (result,check)=>check(result.upstream.status===status,"upstream_refusal"));
}
function checkItems(run:IntegrationRun,data:any[],expected:readonly Variant[],actor:FixtureRole,check:Check,ordered=false){
  const wanted=selected(run,expected);
  check(Array.isArray(data)&&same(data.map(a=>a.id),wanted)&&(!ordered||data.every((a,i)=>a.id===wanted[i])),"exact_assets");
  check(data.every(a=>{const v=expected.find(v=>assetId(run,v)===a.id)!;
    return a.ownerId===run.context.actors[owner(v)].user_id&&a.checksum===photo(run,v).sha1&&a.originalFileName===photo(run,v).filename&&
      a.isFavorite===(actorOwner(actor)===owner(v)&&v!=="discovery_a_private")&&a.visibility==="timeline";
  }),"asset_values");
}
async function search(run:IntegrationRun,id:string,actor:FixtureRole,body:any,expected:readonly Variant[],page:string|null=null,cursor:string|null=null){
  return json(run,id,actor,{operation_id:"searchAssets",body},200,false,["exact_assets","asset_values","page_envelope"],(data,check)=>{
    checkItems(run,data.assets.items,expected,actor,check,true);
    check(data.assets.count===expected.length&&data.assets.total===expected.length&&data.assets.nextPage===page&&data.assets.nextCursor===cursor&&
      data.albums.count===0&&data.albums.total===0&&data.albums.items.length===0,"page_envelope");
  });
}
async function partners(run:IntegrationRun,id:string,actor:Role,direction:"shared-by"|"shared-with"){
  await json(run,id,actor,{operation_id:"getPartners",query:{direction}},200,false,["no_partners"],
    (data,check)=>check(Array.isArray(data)&&data.length===0,"no_partners"));
}
async function preflight(run:IntegrationRun){
  for(const role of ["a","b"] as const){
    for(const direction of ["shared-by","shared-with"] as const)await partners(run,"preflight_"+role+"_"+direction.replace("-","_"),role,direction);
    await search(run,"preflight_empty_"+role,role,{...legacy,size:100},[]);
  }
}
function identity(run:IntegrationRun,v:Variant,data:any){
  return data.id===assetId(run,v)&&data.ownerId===run.context.actors[owner(v)].user_id&&data.checksum===photo(run,v).sha1&&data.originalFileName===photo(run,v).filename;
}
async function seed(run:IntegrationRun){
  for(const [i,v] of variants.entries()){
    const p=photo(run,v),role=owner(v),file=await run.staging.ingest(run.context.actors[role].principal,p.filename,p.mime,
      (async function*(){yield p.bytes;})(),p.bytes.length,undefined,p.sha256);
    const response=await json(run,"upload_"+v,role,{operation_id:"uploadAsset",content_type:"multipart/form-data",files:{assetData:{file_ref:file.file_ref}},
      body:{filename:p.filename,fileCreatedAt:dates[i],fileModifiedAt:dates[i],isFavorite:v!=="discovery_a_private",visibility:"timeline"}},201,true,["new_asset"],
      (data,check)=>check(data.status==="created"&&typeof data.id==="string","new_asset"));
    run.state.data.assets[v]={id:response.data.id};run.save();
  }
  // At most 60 initial and 60 post-sidecar metadata observations; the whole plan stays below 256 receipts.
  for(const phase of ["initial","geocoded"] as const){
    for(const [i,v] of variants.entries()){
      if(phase==="geocoded"){
        await json(run,"set_metadata_"+v,owner(v),{operation_id:"updateAsset",path:{id:assetId(run,v)},
          body:{dateTimeOriginal:dates[i],latitude:points[i]![0],longitude:points[i]![1],description:"MCP discovery "+run.context.lab.state.id,rating:i===0?5:i===1?3:null}},
          200,true,["metadata_written"],(data,check)=>check(identity(run,v,data)&&near(data.exifInfo?.latitude,points[i]![0]!)&&
            near(data.exifInfo?.longitude,points[i]![1]!)&&data.exifInfo?.rating===(i===0?5:i===1?3:null),"metadata_written"));
      }
      let ready=false,last:any;
      for(let attempt=0;attempt<20;attempt++){
        await json(run,phase+"_"+v+"_"+attempt,owner(v),{operation_id:"getAssetInfo",path:{id:assetId(run,v)}},200,false,["known_asset"],(data,check)=>{
          check(identity(run,v,data),"known_asset");last=data;
          ready=data.width===64&&data.height===32&&data.exifInfo?.fileSizeInByte===photo(run,v).bytes.length&&
            (phase==="initial"||data.fileCreatedAt===dates[i]&&near(data.exifInfo.latitude,points[i]![0]!)&&near(data.exifInfo.longitude,points[i]![1]!)&&
              typeof data.exifInfo.city==="string"&&data.exifInfo.city.length>0&&typeof data.exifInfo.country==="string"&&data.exifInfo.country.length>0);
        });
        if(ready)break;if(attempt<19)await delay(1000);
      }
      if(!ready)integrationFailure("fixture_metadata_timeout","Synthetic discovery metadata did not become ready; no upload or metadata write is replayed");
      if(phase==="geocoded"){run.state.data.assets[v]={...run.state.data.assets[v],observed:last};run.save();}
    }
  }
  for(const [key,role,v] of [["shared","a","discovery_a_shared"],["private","a","discovery_a_private"],["b","b","discovery_b"]] as const){
    const name="MCP discovery "+key+" "+run.context.lab.state.id;
    const created=await json(run,"create_album_"+key,role,{operation_id:"createAlbum",body:{albumName:name}},201,true,["new_album"],
      (data,check)=>check(typeof data.id==="string"&&data.albumName===name&&data.assetCount===0,"new_album"));
    run.state.data.albums[key]={id:created.data.id};run.save();
    await json(run,"add_album_"+key,role,{operation_id:"addAssetsToAlbum",path:{id:created.data.id},body:{ids:[assetId(run,v)]}},200,true,["asset_added"],
      (data,check)=>check(data.length===1&&data[0].id===assetId(run,v)&&data[0].success===true,"asset_added"));
  }
  await json(run,"share_album","a",{operation_id:"addUsersToAlbum",path:{id:run.state.data.albums.shared.id},
    body:{albumUsers:[{userId:run.context.actors.b.user_id,role:"viewer"}]}},200,true,["viewer_added"],
    (data,check)=>check(data.albumUsers.some((u:any)=>u.user.id===run.context.actors.b.user_id&&u.role==="viewer"),"viewer_added"));
}
async function markers(run:IntegrationRun,id:string,actor:FixtureRole,query:any,expected:readonly Variant[]){
  await json(run,id,actor,{operation_id:"getMapMarkers",query:{fileCreatedAfter:START,fileCreatedBefore:END,...query}},200,false,
    ["marker_ids","marker_values"],(data,check)=>{
      check(Array.isArray(data)&&same(data.map((a:any)=>a.id),selected(run,expected)),"marker_ids");
      check(data.every((a:any)=>{const v=expected.find(v=>assetId(run,v)===a.id)!,i=variants.indexOf(v),o=run.state.data.assets[v].observed.exifInfo;
        return near(a.lat,points[i]![0]!)&&near(a.lon,points[i]![1]!)&&a.city===o.city&&a.country===o.country&&a.state===o.state;
      }),"marker_values");
    });
}
async function buckets(run:IntegrationRun,id:string,actor:FixtureRole,query:any,count:number){
  await json(run,id,actor,{operation_id:"getTimeBuckets",query},200,false,["bucket_count"],(data,check)=>{
    check(Array.isArray(data)&&data.filter((b:any)=>b.timeBucket===BUCKET).length===1&&data.find((b:any)=>b.timeBucket===BUCKET).count===count&&
      new Set(data.map((b:any)=>b.timeBucket)).size===data.length,"bucket_count");
  });
}
async function bucket(run:IntegrationRun,id:string,actor:FixtureRole,query:any,expected:readonly Variant[]){
  const fields=["status","id","ownerId","ratio","isFavorite","visibility","isTrashed","isImage","thumbhash","createdAt","fileCreatedAt","localOffsetHours","duration","projectionType","livePhotoVideoId","city","country","latitude","longitude"];
  await run.execute({id,actor,call:{operation_id:"getTimeBucket",query:{timeBucket:BUCKET,order:"asc",withCoordinates:true,...query}},
    status:200,kind:"success",mutates:false,assertions:["aligned_columns","timeline_values","retained_raw_status"]},async(result,check)=>{
    const data=result.data;
    check(fields.every(f=>Array.isArray(data[f])&&data[f].length===expected.length)&&same(data.id,selected(run,expected)),"aligned_columns");
    check(expected.every((v,i)=>{const d=run.state.data.assets[v].observed,j=variants.indexOf(v),stamp=data.fileCreatedAt[i],iso=/Z$|[+-]\d\d:\d\d$/.test(stamp)?stamp:stamp+"Z";
      return data.status[i]==="active"&&data.id[i]===assetId(run,v)&&data.ownerId[i]===run.context.actors[owner(v)].user_id&&data.ratio[i]===2&&
        data.isFavorite[i]===(actorOwner(actor)===owner(v)&&v!=="discovery_a_private")&&data.visibility[i]==="timeline"&&!data.isTrashed[i]&&data.isImage[i]&&
        new Date(iso).toISOString()===dates[j]&&data.localOffsetHours[i]===0&&data.duration[i]===null&&
        data.thumbhash[i]===(d.thumbhash??null)&&data.livePhotoVideoId[i]===null&&data.projectionType[i]===(d.exifInfo.projectionType??null)&&
        new Date(/[Zz]$|[+-]\d\d:\d\d$/.test(data.createdAt[i])?data.createdAt[i]:data.createdAt[i]+"Z").getTime()===new Date(d.createdAt).getTime()&&
        near(data.latitude[i],points[j]![0]!)&&near(data.longitude[i],points[j]![1]!)&&data.city[i]===d.exifInfo.city&&data.country[i]===d.exifInfo.country;
    }),"timeline_values");
    const principal=run.context.actors[actor].principal,stored=run.context.vault.get(principal,result.result_ref,"result");
    const raw=JSON.parse((await readDecoded(run.context.vault.rawStream(principal,stored.raw.raw_ref),stored.raw.content_encoding??"identity",1024*1024)).toString("utf8"));
    check(Array.isArray(raw.status)&&raw.status.length===expected.length&&raw.status.every((s:any,i:number)=>s===data.status[i])&&same(raw.id,data.id),"retained_raw_status");
  });
}
function mixed(run:IntegrationRun){
  return {...active,or:[{albumIds:{any:[run.state.data.albums.shared.id]}},{originalFileName:{endsWith:run.context.lab.state.id+".png"}}]};
}
async function partnerScenario(run:IntegrationRun){
  const a=run.context.actors.a.user_id,b=run.context.actors.b.user_id;
  await search(run,"album_search_b","b",{albumIds:[run.state.data.albums.shared.id],size:10,order:"asc",withExif:true},["discovery_a_shared"]);
  await search(run,"mixed_or_b","b",{filter:mixed(run),orderBy:{field:"fileCreatedAt",direction:"asc"},size:10,withExif:true},["discovery_a_shared","discovery_b"]);
  await markers(run,"before_partner_map_b","b",{withPartners:true},["discovery_b"]);
  await json(run,"create_partner","a",{operation_id:"createPartner",body:{sharedWithId:b}},201,true,["partner_default"],
    (data,check)=>check(data.id===b&&data.inTimeline===false,"partner_default"));
  await search(run,"disabled_partner_search_b","b",{...legacy,size:10,order:"asc",withExif:true},["discovery_b"]);
  await markers(run,"disabled_partner_map_b","b",{withPartners:true},variants);
  await buckets(run,"disabled_partner_timeline_b","b",{visibility:"timeline",withPartners:true},1);
  await json(run,"enable_partner_timeline","b",{operation_id:"updatePartner",path:{id:a},body:{inTimeline:true}},200,true,["timeline_enabled"],
    (data,check)=>check(data.id===a&&data.inTimeline===true,"timeline_enabled"));
  await search(run,"enabled_partner_search_b","b",{...legacy,size:10,order:"asc",withExif:true},variants);
  await bucket(run,"enabled_partner_bucket_b","b",{visibility:"timeline",withPartners:true},variants);
  await json(run,"remove_partner","a",{operation_id:"removePartner",path:{id:b}},204,true,["removed"],(data,check)=>check(data===null,"removed"));
  await json(run,"archive_private","a",{operation_id:"updateAsset",path:{id:assetId(run,"discovery_a_private")},body:{visibility:"archive"}},200,true,["archived"],
    (data,check)=>check(data.id===assetId(run,"discovery_a_private")&&data.visibility==="archive","archived"));
  await markers(run,"archive_default_map_a","a",{},["discovery_a_shared"]);
  await markers(run,"archive_included_map_a","a",{isArchived:true},["discovery_a_shared","discovery_a_private"]);
  await json(run,"restore_private_timeline","a",{operation_id:"updateAsset",path:{id:assetId(run,"discovery_a_private")},body:{visibility:"timeline"}},200,true,["restored"],
    (data,check)=>check(data.id===assetId(run,"discovery_a_private")&&data.visibility==="timeline","restored"));
}
async function verify(run:IntegrationRun){
  const d=run.state.data,cursor=Buffer.from(JSON.stringify({offset:1})).toString("base64url");
  for(const role of ["a","b"] as const)for(const direction of ["shared-by","shared-with"] as const)
    await partners(run,"final_"+role+"_"+direction.replace("-","_"),role,direction);
  await search(run,"legacy_page_1_a","a",{...legacy,size:1,page:1,order:"asc",withExif:true},["discovery_a_shared"],"2");
  await search(run,"legacy_page_2_a","a",{...legacy,size:1,page:2,order:"asc",withExif:true},["discovery_a_private"]);
  await search(run,"structured_page_1_a","a",{filter:active,size:1,orderBy:{field:"fileCreatedAt",direction:"asc"},withExif:true},["discovery_a_shared"],null,cursor);
  await search(run,"structured_page_2_a","a",{filter:active,size:1,cursor,orderBy:{field:"fileCreatedAt",direction:"asc"},withExif:true},["discovery_a_private"]);
  await search(run,"final_search_b","b",{...legacy,size:10,order:"asc",withExif:true},["discovery_b"]);
  await search(run,"final_mixed_or_b","b",{filter:mixed(run),size:10,orderBy:{field:"fileCreatedAt",direction:"asc"},withExif:true},["discovery_a_shared","discovery_b"]);
  await search(run,"restricted_search","restricted",{filter:active,size:10,orderBy:{field:"fileCreatedAt",direction:"asc"},withExif:true},["discovery_a_shared","discovery_a_private"]);
  for(const [key,actor,call,expected] of [
    ["random_a","a",{operation_id:"searchRandom",body:{filter:active,size:10,withExif:true}},["discovery_a_shared","discovery_a_private"]],
    ["large_a","a",{operation_id:"searchLargeAssets",query:{...legacy,size:10,minFileSize:0,withExif:true}},["discovery_a_shared","discovery_a_private"]]
  ] as [string,FixtureRole,ApiCall,Variant[]][]){
    await json(run,key,actor,call,200,false,["exact_assets","asset_values"],(data,check)=>checkItems(run,data,expected,actor,check));
  }
  await json(run,"statistics_a","a",{operation_id:"searchAssetStatistics",body:{filter:active}},200,false,["exact_total"],(data,check)=>check(data.total===2,"exact_total"));
  for(const [id,actor,query,count,expected] of [
    ["owner_a","a",{visibility:"timeline"},2,["discovery_a_shared","discovery_a_private"]],
    ["shared_b","b",{albumId:d.albums.shared.id,visibility:"timeline"},1,["discovery_a_shared"]],
    ["restricted_a","restricted",{visibility:"timeline"},2,["discovery_a_shared","discovery_a_private"]]
  ] as [string,FixtureRole,any,number,Variant[]][]){await buckets(run,"buckets_"+id,actor,query,count);await bucket(run,"bucket_"+id,actor,query,expected);}
  await markers(run,"final_map_a","a",{},["discovery_a_shared","discovery_a_private"]);
  await markers(run,"final_map_b","b",{},["discovery_b"]);
  await markers(run,"final_map_shared_b","b",{withSharedAlbums:true},["discovery_a_shared","discovery_b"]);
  await markers(run,"favorite_map_a","a",{isFavorite:true},["discovery_a_shared"]);
  await json(run,"inclusive_map_boundary","a",{operation_id:"getMapMarkers",query:{fileCreatedAfter:dates[0],fileCreatedBefore:dates[0]}},200,false,
    ["marker_boundary"],(data,check)=>check(data.length===1&&data[0].id===assetId(run,"discovery_a_shared"),"marker_boundary"));
  await json(run,"reverse_geocode","a",{operation_id:"reverseGeocode",query:{lat:points[0]![0],lon:points[0]![1]}},200,false,["known_geography"],
    (data,check)=>check(data.length===1&&["city","state","country"].every(k=>data[0][k]===d.assets.discovery_a_shared.observed.exifInfo[k]),"known_geography"));
  await json(run,"places","a",{operation_id:"searchPlaces",query:{name:"Tokyo"}},200,false,["nonempty_places"],
    (data,check)=>check(data.length>0&&data.some((p:any)=>p.latitude>34&&p.latitude<37&&p.longitude>138&&p.longitude<141),"nonempty_places"));
  for(const actor of ["a","restricted"] as const){
    await json(run,"suggestions_"+actor,actor,{operation_id:"getSearchSuggestions",query:{type:"city",includeNull:true}},200,false,["city_suggestions"],
      (data,check)=>check(Array.isArray(data)&&data.at(-1)===null&&variants.filter(v=>owner(v)==="a").every(v=>data.includes(d.assets[v].observed.exifInfo.city)),"city_suggestions"));
  }
  await json(run,"cities_a","a",{operation_id:"getAssetsByCity"},200,false,["city_representatives"],(data,check)=>{
    const cities=variants.filter(v=>owner(v)==="a").map(v=>d.assets[v].observed.exifInfo.city);
    check(data.length>0&&data.every((a:any)=>a.ownerId===run.context.actors.a.user_id&&a.isFavorite===false)&&cities.every(c=>data.some((a:any)=>a.exifInfo?.city===c)),"city_representatives");
  });
  await json(run,"explore_a","a",{operation_id:"getExploreData"},200,false,["nonempty_recent_explore"],(data,check)=>{
    const recent=data.find((f:any)=>f.fieldName==="createdAt");
    check(Array.isArray(recent?.items)&&selected(run,["discovery_a_shared","discovery_a_private"]).every(id=>recent.items.some((i:any)=>i.data.id===id))&&
      data.every((f:any)=>f.items.every((i:any)=>i.data.ownerId===run.context.actors.a.user_id)),"nonempty_recent_explore");
  });
  for(const role of ["a","b"] as const){
    const own=variants.filter(v=>owner(v)===role),folders=[...new Set(own.map(v=>posix.dirname(d.assets[v].observed.originalPath)))];
    await json(run,"paths_"+role,role,{operation_id:"getUniqueOriginalPaths"},200,false,["known_folders"],(data,check)=>
      check(Array.isArray(data)&&folders.every(f=>data.includes(f))&&data.every((f:any)=>typeof f==="string"&&!f.endsWith("/"))&&new Set(data).size===data.length&&data.every((f:string,i:number)=>i===0||data[i-1]<=f),"known_folders"));
    for(const [index,folder] of folders.entries()){
      await json(run,"folder_"+role+"_"+index,role,{operation_id:"getAssetsByOriginalPath",query:{path:folder+"/"}},200,false,["direct_owned_children"],(data,check)=>{
        const known=own.filter(v=>posix.dirname(d.assets[v].observed.originalPath)===folder),paths=data.map((a:any)=>posix.basename(a.originalPath));
        check(Array.isArray(data)&&known.every(v=>data.some((a:any)=>a.id===assetId(run,v)))&&data.every((a:any)=>a.ownerId===run.context.actors[role].user_id&&
          posix.dirname(a.originalPath)===folder&&a.visibility==="timeline")&&paths.every((p:string,i:number)=>i===0||paths[i-1]!<=p),"direct_owned_children");
      });
    }
  }
  await refused(run,"private_album_search_b","b",{operation_id:"searchAssets",body:{filter:{albumIds:{any:[d.albums.private.id]}}}},400);
  await refused(run,"private_album_timeline_b","b",{operation_id:"getTimeBuckets",query:{albumId:d.albums.private.id}},400);
  await refused(run,"invalid_cursor","a",{operation_id:"searchAssets",body:{filter:active,cursor:"invalid-cursor"}},400);
  await refused(run,"mixed_shapes","a",{operation_id:"searchAssets",body:{filter:active,isFavorite:true}},400);
  for(const op of ["searchAssets","searchSmart"]){
    await refused(run,"locked_"+op.toLowerCase(),"a",{operation_id:op,body:{visibility:"locked",...(op==="searchSmart"?{query:"synthetic"}:{})}},401);
  }
  for(const op of ["getTimeBuckets","getTimeBucket"]){
    await refused(run,"locked_"+op.toLowerCase(),"a",{operation_id:op,query:{visibility:"locked",...(op==="getTimeBucket"?{timeBucket:BUCKET}:{})}},401);
  }
  await refused(run,"incompatible_partner_filters","a",{operation_id:"getTimeBuckets",query:{withPartners:true,visibility:"timeline",isFavorite:false}},400);
  const restricted:ApiCall[]=[
    {operation_id:"searchAssetStatistics",body:{filter:active}},{operation_id:"searchPerson",query:{name:"MCP "+run.context.lab.state.id}},
    {operation_id:"getMapMarkers"},{operation_id:"reverseGeocode",query:{lat:points[0]![0],lon:points[0]![1]}},
    {operation_id:"getUniqueOriginalPaths"},{operation_id:"getAssetsByOriginalPath",query:{path:posix.dirname(d.assets.discovery_a_shared.observed.originalPath)}}
  ];
  for(const call of restricted)await refused(run,"restricted_"+call.operation_id.toLowerCase(),"restricted",call,403);
}
export async function createDiscoveryFixtures(directory:string,options:LabOptions={}){
  return withInitializedFixtureLab(directory,async context=>{
    const run=new IntegrationRun(context,DISCOVERY_PLAN);
    try{
      if(!run.revalidate){run.state.data={assets:{},albums:{}};run.save();await preflight(run);await seed(run);await partnerScenario(run);}
      await verify(run);run.finish();const report=await run.publish();
      return {state:run.revalidate?"discovery_fixtures_revalidated":"discovery_fixtures_ready",execution_scope:run.state.execution_scope,synthetic_assets:3,
        retained_albums:3,remaining_a_b_partners:0,conditional_positive_workflows:["searchSmart","searchPerson"],report,
        api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false};
    }catch(error){
      if(run.completionCommitted)return integrationFailure("fixture_report_failed","Discovery completion is committed; retry only read-only revalidation and publication");
      try{run.fail(error);await run.publish();}catch{/* Preserve durable evidence even when report publication fails. */}
      if(run.revalidate)return integrationFailure("fixture_validation_failed","Discovery readbacks changed; no mutation was replayed");
      return integrationFailure("fixture_recovery_required","Discovery setup did not finish; preserve evidence and prepare a new disposable run");
    }
  },options);
}
