import assert from "node:assert/strict";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
import { mediaBackend } from "./media-harness.js";
import { posix } from "node:path";

// A source-derived semantic model, never evidence of running Immich itself.
export function discoveryBackend(){
  const base=mediaBackend(),{backend}=base;
  const model=Object.assign(base.model,{partners:[] as any[],leakMixedOr:false,badLegacyCursor:false,misalignBucket:false,badMarker:false,foreignFolder:false});
  const publicUser=(u:any)=>({...sample(registry.schemas.UserResponseDto!),id:u.id,email:u.email,name:u.name});
  function normalize(a:any){
    if(a.exif)return a;
    a.date??="2023-07-18T01:00:00.000Z";a.path??="/data/upload/"+a.owner.id+"/ab/"+a.id+".png";a.visibility??="timeline";
    a.exif={...sample(registry.schemas.ExifResponseDto!),fileSizeInByte:a.bytes.length,exifImageWidth:64,exifImageHeight:32,
      latitude:null,longitude:null,city:null,state:null,country:null,rating:null};return a;
  }
  const asset=(a:any,viewer:any,withExif=true)=>{
    normalize(a);
    return {...sample(registry.schemas.AssetResponseDto!),id:a.id,ownerId:a.owner.id,owner:publicUser(a.owner),checksum:a.checksum,
      originalFileName:a.filename,originalPath:a.path,fileCreatedAt:a.date,fileModifiedAt:a.date,localDateTime:a.date,
      createdAt:"2026-11-10T00:00:00.000Z",updatedAt:"2026-11-10T00:00:00.000Z",width:64,height:32,type:"IMAGE",visibility:a.visibility,
      isFavorite:viewer?.id===a.owner.id&&a.favorite,isArchived:a.visibility==="archive",isTrashed:false,duration:null,thumbhash:null,livePhotoVideoId:null,
      exifInfo:withExif?a.exif:undefined};
  };
  const albumAccess=(id:string,user:any)=>model.albums.some(a=>a.id===id&&(a.owner.id===user.id||a.viewers.some((v:any)=>v.user.id===user.id)));
  const inAlbum=(a:any,id:string)=>model.albums.some(x=>x.id===id&&x.assets.has(a.id));
  const incoming=(user:any,timeline=false)=>model.partners.filter(p=>p.to.id===user.id&&(!timeline||p.inTimeline)).map(p=>p.from.id);
  const owned=(a:any,user:any)=>a.owner.id===user.id||incoming(user,true).includes(a.owner.id);
  const confined=(f:any)=>!!f?.albumIds?.any||!!f?.albumIds?.all;
  function branch(a:any,f:any){
    for(const [key,value] of Object.entries<any>(f)){
      if(key==="or")continue;
      if(key==="albumIds"){
        if(value.any&&!value.any.some((id:string)=>inAlbum(a,id))||value.all&&!value.all.every((id:string)=>inAlbum(a,id))||
          value.none&&value.none.some((id:string)=>inAlbum(a,id)))return false;
        continue;
      }
      const actual=key==="takenAt"?a.date:key==="trashedAt"?null:key==="originalFileName"?a.filename:key==="id"?a.id:
        key==="isFavorite"?a.favorite:key==="visibility"?a.visibility:key==="type"?"IMAGE":a.exif[key];
      if(Object.hasOwn(value,"eq")&&actual!==value.eq||Object.hasOwn(value,"ne")&&actual===value.ne||
        value.gte!==undefined&&actual<value.gte||value.lte!==undefined&&actual>value.lte||
        value.endsWith!==undefined&&!String(actual).endsWith(value.endsWith)||value.startsWith!==undefined&&!String(actual).startsWith(value.startsWith))return false;
    }return true;
  }
  function filtered(user:any,body:any){
    const values=model.assets.map(normalize).filter(a=>a.visibility!=="locked");
    if(body.filter){
      const f=body.filter;
      return values.filter(a=>branch(a,f)&&(f.or?f.or.some((b:any)=>branch(a,b)&&(confined(f)||confined(b)||owned(a,user))):confined(f)||owned(a,user)));
    }
    return values.filter(a=>(body.albumIds?.length?body.albumIds.every((id:string)=>inAlbum(a,id)):owned(a,user))&&
      (!body.takenAfter||a.date>=body.takenAfter)&&(!body.takenBefore||a.date<=body.takenBefore)&&
      (body.visibility===undefined||a.visibility===body.visibility)&&(!body.id||body.id===a.id));
  }
  const point=(latitude:number)=>latitude>40?{city:"Paris",state:"Ile-de-France",country:"France"}:{city:"Tokyo",state:"Tokyo",country:"Japan"};
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(path==="/api/assets"&&method==="POST"){
      const response=await base.http(input,init);
      if(response.status===201){
        const data=await response.clone().json() as any,a=model.assets.find(a=>a.id===data.id),fields=backend.calls.at(-1)!.body.fields;
        a.date=fields.fileCreatedAt;normalize(a);
      }return response;
    }
    const assetMatch=/^\/api\/assets\/([^/]+)$/.exec(path);
    if(!assetMatch&&!/^\/api\/(search|timeline|map|view|partners)(\/|$)/.test(path))return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");
    assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);assert.equal(headers.get("cf-access-jwt-assertion"),null);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner;
    if(path==="/api/search/large-assets")assert.equal(init.body,undefined);
    const body=path==="/api/search/large-assets"?Object.fromEntries([...url.searchParams].map(([k,v])=>[k,["size","minFileSize"].includes(k)?Number(v):k==="withExif"?v==="true":v])):init.body?JSON.parse(String(init.body)):undefined,record={path,method,headers,body};backend.calls.push(record);await backend.before?.(path,body);
    const finish=(data:any,status=200)=>status===204?new Response(null,{status}):Response.json(backend.after?.(path,data)??data,{status});
    const denied=()=>finish({message:"not found or no access"},400);
    if(!key||!user)return finish({message:"missing caller"},401);
    if(!key.permissions.includes("all")){
      const readScope=assetMatch&&method==="GET"||path.startsWith("/api/timeline/")||
        path.startsWith("/api/search/")&&!["/api/search/statistics","/api/search/person"].includes(path);
      if(!readScope||!key.permissions.includes("asset.read"))return finish({message:"permission refused"},403);
    }
    if(assetMatch){
      const a=model.assets.find(a=>a.id===assetMatch[1]);if(!a)return denied();normalize(a);
      if(method==="PUT"){
        if(a.owner.id!==user.id)return denied();
        if(Object.hasOwn(body,"visibility"))a.visibility=body.visibility;
        if(Object.hasOwn(body,"isFavorite"))a.favorite=body.isFavorite;
        for(const k of ["latitude","longitude","description","rating"])if(Object.hasOwn(body,k))a.exif[k]=body[k];
        if(body.dateTimeOriginal){a.date=body.dateTimeOriginal;a.exif.dateTimeOriginal=body.dateTimeOriginal;}
        if(a.exif.latitude!==null&&a.exif.longitude!==null)Object.assign(a.exif,point(a.exif.latitude));
      }else if(a.owner.id!==user.id&&!model.albums.some(x=>x.assets.has(a.id)&&x.viewers.some((v:any)=>v.user.id===user.id))&&!incoming(user).includes(a.owner.id))return denied();
      return finish(asset(a,user));
    }
    if(path.startsWith("/api/partners")){
      const id=method==="POST"&&path==="/api/partners"?body.sharedWithId:path.split("/")[3];
      if(!id){const giving=url.searchParams.get("direction")==="shared-by";return finish(model.partners.filter(p=>(giving?p.from:p.to).id===user.id).map(p=>({...publicUser(giving?p.to:p.from),inTimeline:p.inTimeline})));}
      const peer=backend.users.find(u=>u.id===id);if(!peer)return denied();
      if(method==="POST"){model.partners.push({from:user,to:peer,inTimeline:false});return finish({...publicUser(peer),inTimeline:false},201);}
      if(method==="PUT"){const p=model.partners.find(p=>p.from.id===id&&p.to.id===user.id);if(!p)return denied();p.inTimeline=body.inTimeline;return finish({...publicUser(peer),inTimeline:p.inTimeline});}
      const p=model.partners.find(p=>p.from.id===user.id&&p.to.id===id);if(!p)return denied();model.partners.splice(model.partners.indexOf(p),1);return finish(null,204);
    }
    if(path.startsWith("/api/search/")){
      if(body?.visibility==="locked"||body?.filter?.visibility?.eq==="locked")return finish({message:"elevated session required"},401);
      if(path==="/api/search/places")return finish([{name:"Tokyo",latitude:35.6895,longitude:139.6917,admin1name:"Tokyo"}]);
      if(path==="/api/search/person")return finish([]);
      if(path==="/api/search/smart")return finish({message:"query asset embedding absent"},400);
      if(path==="/api/search/suggestions"){
        const cities=[...new Set(model.assets.filter(a=>owned(a,user)).map(a=>normalize(a).exif.city).filter(Boolean))].sort();
        return finish(url.searchParams.get("includeNull")==="true"?[...cities,null]:cities);
      }
      if(path==="/api/search/cities"){
        const byCity=new Map<string,any>();for(const a of model.assets.filter(a=>owned(a,user)&&normalize(a).visibility==="timeline"))if(a.exif.city&&!byCity.has(a.exif.city))byCity.set(a.exif.city,a);
        return finish([...byCity.values()].map(a=>asset(a,null)));
      }
      if(path==="/api/search/explore"){
        const own=model.assets.filter(a=>a.owner.id===user.id&&normalize(a).visibility==="timeline");
        return finish([{fieldName:"city",items:[]},{fieldName:"createdAt",items:own.slice(-12).map(a=>({value:"2026-11-10T00:00:00.000Z",data:asset(a,user)}))}]);
      }
      if(body?.filter&&["isFavorite","visibility","takenAfter","takenBefore","albumIds"].some(k=>Object.hasOwn(body,k)))return finish({message:"mixed search shapes"},400);
      const albumIds=[...(body?.albumIds??[]),...(body?.filter?.albumIds?.any??[]),...(body?.filter?.albumIds?.all??[]),
        ...(body?.filter?.or??[]).flatMap((b:any)=>[...(b.albumIds?.any??[]),...(b.albumIds?.all??[])])];
      if(albumIds.some(id=>!albumAccess(id,user)))return denied();
      let all=filtered(user,body??{}).toSorted((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
      if(path==="/api/search/statistics")return finish({total:all.length});
      if(path==="/api/search/random")return finish(all.slice(0,body.size??250).reverse().map(a=>asset(a,user,body.withExif)));
      if(path==="/api/search/large-assets")return finish(all.filter(a=>a.exif.fileSizeInByte>(body.minFileSize??0)).toSorted((a,b)=>b.bytes.length-a.bytes.length).slice(0,body.size??250).map(a=>asset(a,user,body.withExif)));
      if(path==="/api/search/metadata"){
        if(model.leakMixedOr&&body.filter?.or){const leaked=model.assets.find(a=>a.owner.id!==user.id&&a.filename.includes("discovery_a_private"));if(leaked)all.push(leaked);}
        const structured=body.filter!==undefined||body.orderBy!==undefined||body.cursor!==undefined;
        if((structured?body.orderBy?.direction:body.order)!=="asc")all.reverse();
        let offset=structured?0:((body.page??1)-1)*(body.size??250),size=body.size??250;
        if(body.cursor){try{const parsed=JSON.parse(Buffer.from(body.cursor,"base64url").toString());if(!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw Error();offset=parsed.offset;}catch{return finish({message:"invalid cursor"},400);}}
        const page=all.slice(offset,offset+size),more=all.length>offset+size,nextPage=!structured&&more?String((body.page??1)+1):null,
          nextCursor=structured&&more?Buffer.from(JSON.stringify({offset:offset+size})).toString("base64url"):null;
        return finish({albums:{total:0,count:0,items:[],facets:[]},assets:{total:page.length,count:page.length,items:page.map(a=>asset(a,user,body.withExif)),facets:[],
          nextPage:model.badLegacyCursor&&nextPage?"3":nextPage,nextCursor}});
      }
    }
    if(path.startsWith("/api/timeline/")){
      const q=url.searchParams,album=q.get("albumId"),visibility=q.get("visibility");
      if(visibility==="locked")return finish({message:"elevated session required"},401);
      if(album&&!albumAccess(album,user))return denied();
      if(q.get("withPartners")==="true"&&(visibility!=="timeline"||q.has("isFavorite")||q.get("isTrashed")==="true"))return finish({message:"incompatible partner filters"},400);
      const owners=[user.id,...(q.get("withPartners")==="true"?incoming(user,true):[])];
      let all=model.assets.map(normalize).filter(a=>(album?inAlbum(a,album):owners.includes(a.owner.id))&&(visibility?a.visibility===visibility:["timeline","archive"].includes(a.visibility)));
      if(path.endsWith("/buckets")){
        const counts=new Map<string,number>();for(const a of all){const key=a.date.slice(0,7)+"-01";counts.set(key,(counts.get(key)??0)+1);}
        return finish([...counts].map(([timeBucket,count])=>({timeBucket,count})).sort((a,b)=>b.timeBucket.localeCompare(a.timeBucket)));
      }
      all=all.filter(a=>a.date.slice(0,7)+"-01"===q.get("timeBucket")).sort((a,b)=>a.date.localeCompare(b.date)||a.filename.localeCompare(b.filename));
      if(q.get("order")!=="asc")all.reverse();
      const data:any={id:[],ownerId:[],ratio:[],isFavorite:[],visibility:[],isTrashed:[],isImage:[],thumbhash:[],createdAt:[],fileCreatedAt:[],
        localOffsetHours:[],duration:[],projectionType:[],livePhotoVideoId:[],city:[],country:[],latitude:[],longitude:[],status:[]};
      for(const a of all){
        const row={id:a.id,ownerId:a.owner.id,ratio:2,isFavorite:a.owner.id===user.id&&a.favorite,visibility:a.visibility,isTrashed:false,isImage:true,thumbhash:null,
          createdAt:"2026-11-10T00:00:00",fileCreatedAt:a.date.replace("Z",""),localOffsetHours:0,duration:null,projectionType:null,livePhotoVideoId:null,
          city:a.exif.city,country:a.exif.country,latitude:a.exif.latitude,longitude:a.exif.longitude,status:"active"};
        for(const [k,value] of Object.entries(row))data[k].push(value);
      }
      if(model.misalignBucket&&all.length)data.ownerId.pop();
      return finish(data);
    }
    if(path==="/api/map/reverse-geocode")return finish([point(Number(url.searchParams.get("lat")))]);
    if(path==="/api/map/markers"){
      const q=url.searchParams,owners=[user.id,...(q.get("withPartners")==="true"?incoming(user):[])];
      const albums=q.get("withSharedAlbums")==="true"?model.albums.filter(a=>albumAccess(a.id,user)).map(a=>a.id):[];
      const all=model.assets.map(normalize).filter(a=>(owners.includes(a.owner.id)||albums.some(id=>inAlbum(a,id)))&&a.exif.latitude!==null&&a.exif.longitude!==null&&
        (a.visibility==="timeline"||q.get("isArchived")==="true"&&a.visibility==="archive"&&a.owner.id===user.id)&&
        (!q.has("fileCreatedAfter")||a.date>=q.get("fileCreatedAfter")!)&&(!q.has("fileCreatedBefore")||a.date<=q.get("fileCreatedBefore")!)&&
        (!q.has("isFavorite")||String(a.favorite)===q.get("isFavorite")));
      const values=all.map(a=>({id:a.id,lat:a.exif.latitude,lon:a.exif.longitude,city:a.exif.city,state:a.exif.state,country:a.exif.country}));
      if(model.badMarker&&values.length)values[0]!.lat=0;
      return finish(values);
    }
    if(path.startsWith("/api/view/folder")){
      const own=model.assets.map(normalize).filter(a=>a.owner.id===user.id&&a.visibility==="timeline");
      if(path.endsWith("/unique-paths"))return finish([...new Set(own.map(a=>posix.dirname(a.path)))].sort());
      const dir=url.searchParams.get("path")!.replace(/\/+$/,"");
      let all=own.filter(a=>posix.dirname(a.path)===dir).sort((a,b)=>posix.basename(a.path).localeCompare(posix.basename(b.path)));
      if(model.foreignFolder){const other=model.assets.find(a=>a.owner.id!==user.id);if(other)all=[...all,other];}
      return finish(all.map(a=>asset(a,user)));
    }
    throw Error("Unexpected discovery model route "+method+" "+path);
  }) as typeof fetch;
  return {backend,model,http};
}
