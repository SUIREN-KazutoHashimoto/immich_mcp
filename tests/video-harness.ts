import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { fixtureBackend } from "./bootstrap-harness.js";
import { sample } from "./fixtures.js";
import { registry } from "../src/registry.js";
import { syntheticVideo } from "../src/integration-video-media.js";

export function videoBackend(){
  const base=fixtureBackend(),{backend}=base;
  const initial=sample(registry.schemas.AdminConfigDto!);
  initial.ffmpeg.realtime={enabled:false,resolutions:[720],videoCodecs:["hevc"]};initial.ffmpeg.transcode="optimal";
  initial.oauth.clientSecret="oauth-canary-"+randomUUID();initial.notifications.smtp.transport.password="smtp-canary-"+randomUUID();
  const model={config:structuredClone(initial),initialConfig:structuredClone(initial),assets:[] as any[],sessions:new Map<string,any>(),
    lostMaster:false,badMaster:false,badFragment:false,corruptRange:false,restoreNoEffect:false,metadataPending:0,masterCalls:0,segmentCalls:0};
  const http=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),path=url.pathname,method=init.method??"GET",headers=new Headers(init.headers);
    if(!path.startsWith("/api/assets")&&path!=="/api/admin/config")return base.http(input,init);
    assert.equal(url.origin,"http://127.0.0.1:22835");assert.ok(["manual","error"].includes(init.redirect));
    for(const name of ["authorization","cookie","cf-access-jwt-assertion","x-immich-user-token","x-immich-session-token","x-immich-share-key","x-immich-share-slug"])assert.equal(headers.get(name),null);
    const record={path,method,headers,body:undefined as any};backend.calls.push(record);await backend.before?.(path,undefined);
    const key=backend.keys.find(k=>k.secret===headers.get("x-api-key")),user=key?.owner;
    const finish=(value:any,status=200)=>Response.json(backend.after?.(path,value)??value,{status});
    if(!key||!user)return finish({message:"no caller"},401);
    if(!key.permissions.includes("all")&&!(method==="GET"&&/^\/api\/assets\/[^/]+$/.test(path)&&key.permissions.includes("asset.read")))return finish({message:"scope refused"},403);
    if(path==="/api/admin/config"){
      if(!user.isAdmin)return finish({message:"admin required"},403);
      if(method==="PUT"){
        const body=JSON.parse(String(init.body));record.body=body;
        if(!model.restoreNoEffect||body.ffmpeg.realtime.enabled)model.config=body;
      }
      return finish(structuredClone(model.config));
    }
    if(path==="/api/assets"&&method==="POST"){
      const request=new Request(url,{method,headers,body:init.body,duplex:"half"} as any),form=await request.formData(),file=form.get("assetData") as File;
      assert.ok(file instanceof File);assert.equal(file.type,"video/mp4");assert.equal(form.get("filename"),file.name);
      const bytes=Buffer.from(await file.arrayBuffer()),checksum=createHash("sha1").update(bytes).digest("base64"),
        match=/video-([ab])-([a-f0-9-]+)\.mp4$/.exec(file.name);assert.ok(match);
      const media=syntheticVideo(match[2]!,match[1] as "a"|"b");assert.deepEqual(bytes,media.bytes);
      record.body={filename:file.name,size:bytes.length,fields:Object.fromEntries([...form].filter(([,v])=>typeof v==="string"))};
      const asset={id:randomUUID(),owner:user,bytes,checksum,filename:file.name,media};model.assets.push(asset);
      return finish({id:asset.id,status:"created"},201);
    }
    const match=/^\/api\/assets\/([^/]+)(.*)$/.exec(path);assert.ok(match);
    const asset=model.assets.find(asset=>asset.id===match[1]);
    if(!asset||asset.owner.id!==user.id)return finish({message:"no asset access"},400);
    const tail=match[2];
    if(!tail){
      const pending=model.metadataPending>0;if(pending)model.metadataPending--;
      return finish({...sample(registry.schemas.AssetResponseDto!),id:asset.id,ownerId:user.id,originalFileName:asset.filename,checksum:asset.checksum,
        type:"VIDEO",duration:pending?null:asset.media.durationMs,exifInfo:{...sample(registry.schemas.ExifResponseDto!),exifImageWidth:pending?null:320,exifImageHeight:pending?null:180}});
    }
    if(tail==="/original"||tail==="/video/playback"){
      const full=asset.bytes,range=headers.get("range");
      if(!range)return new Response(new Uint8Array(full),{headers:{"content-type":"video/mp4","content-length":String(full.length),"accept-ranges":"bytes"}});
      const suffix=/^bytes=-(\d+)$/.exec(range),ordinary=/^bytes=(\d+)-(\d*)$/.exec(range);assert.ok(suffix||ordinary);
      const start=suffix?Math.max(0,full.length-Number(suffix[1])):Number(ordinary![1]),end=suffix?full.length-1:ordinary![2]?Number(ordinary![2]):full.length-1;
      // The fixed sendFile helper forwards callback errors as NotFoundException.
      if(start>=full.length)return new Response(JSON.stringify({message:"Not Found",error:"Not Found",statusCode:404}),{status:404,headers:{"content-type":"application/json","content-range":"bytes */"+full.length}});
      const part=Buffer.from(full.subarray(start,Math.min(end+1,full.length)));if(model.corruptRange)part[0]=part[0]!^255;
      return new Response(new Uint8Array(part),{status:206,headers:{"content-type":"video/mp4","content-range":"bytes "+start+"-"+Math.min(end,full.length-1)+"/"+full.length}});
    }
    if(tail==="/video/stream/main.m3u8"){
      model.masterCalls++;if(!model.config.ffmpeg.realtime.enabled)return finish({message:"realtime disabled"},400);
      const id=randomUUID();model.sessions.set(id,{asset:asset.id,owner:user.id});if(model.lostMaster)throw Error("lost main acknowledgement after creating playback session");
      return new Response('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=320x180,CODECS="avc1.420015,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=10\n'+
        (model.badMaster?"https://elsewhere.invalid/":id+"/")+"2/playlist.m3u8\n",{headers:{"content-type":"application/vnd.apple.mpegurl"}});
    }
    const hls=/^\/video\/stream\/([^/]+)(?:\/(\d+)\/(playlist\.m3u8|init\.mp4|seg_\d+\.m4s))?$/.exec(tail!);assert.ok(hls);
    const session=model.sessions.get(hls[1]!);if(!session)return finish({message:"no session"},404);
    assert.equal(session.owner,user.id);assert.equal(session.asset,asset.id);
    if(method==="DELETE"){model.sessions.delete(hls[1]!);return new Response(null,{status:204});}
    assert.equal(hls[2],"2");
    if(hls[3]==="playlist.m3u8"){
      assert.equal(headers.get("x-immich-hls-pos"),"0");
      return new Response('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nseg_0.m4s\n#EXTINF:1.936867,\nseg_1.m4s\n#EXT-X-ENDLIST\n',{headers:{"content-type":"application/vnd.apple.mpegurl"}});
    }
    model.segmentCalls++;
    const file=hls[3]!,index=file==="init.mp4"?0:Number(/seg_(\d+)/.exec(file)![1]);assert.equal(headers.get("x-immich-hls-msn"),String(index));
    const data=model.badFragment&&file!=="init.mp4"?Buffer.from("bad fragment"):file==="init.mp4"?asset.media.init:asset.media.fragments[index];
    assert.ok(data);return new Response(new Uint8Array(data),{headers:{"content-type":"video/mp4"}});
  }) as typeof fetch;
  return {backend,model,http};
}
