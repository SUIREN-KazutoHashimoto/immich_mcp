import { createHash } from "node:crypto";
import fixture from "../contracts/synthetic-video.v1.json" with {type:"json"};
import { BridgeError } from "./types.js";

function invalid():never{throw new BridgeError("fixture_video","Invalid synthetic video or fixed-version HLS response");}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface Mp4Box {type:string;start:number;end:number;header:number;}
/** Bounded top-level ISO-BMFF framing only; this does not validate/decode a codec. */
export function mp4Boxes(bytes:Buffer):Mp4Box[]{
  if(!bytes.length||bytes.length>16*1024*1024)invalid();
  const boxes:Mp4Box[]=[];let at=0;
  while(at<bytes.length){
    if(boxes.length>=4096||bytes.length-at<8)invalid();
    const short=bytes.readUInt32BE(at),header=short===1?16:8;
    if(bytes.length-at<header)invalid();
    const wide=short===1?bytes.readBigUInt64BE(at+8):BigInt(short===0?bytes.length-at:short);
    if(wide>BigInt(Number.MAX_SAFE_INTEGER))invalid();
    const size=Number(wide),type=bytes.toString("latin1",at+4,at+8);
    if(size<header||size>bytes.length-at||!/^[\x20-\x7e]{4}$/.test(type))invalid();
    boxes.push({type,start:at,end:at+size,header});at+=size;
  }
  return boxes;
}
export function assertVideoInit(bytes:Buffer){
  const boxes=mp4Boxes(bytes),types=boxes.map(b=>b.type);
  if(types.filter(x=>x==="ftyp").length!==1||types.filter(x=>x==="moov").length!==1||types.includes("moof")||types.includes("mdat")||
    types.indexOf("ftyp")>types.indexOf("moov"))invalid();
  return boxes;
}
export function assertVideoFragment(bytes:Buffer){
  const boxes=mp4Boxes(bytes);let pairs=0,pending=false;
  for(const box of boxes){
    if(box.type==="moof"){if(pending)invalid();pending=true;}
    if(box.type==="mdat"){if(!pending||box.end-box.start<=box.header)invalid();pending=false;pairs++;}
    if(box.type==="ftyp"||box.type==="moov")invalid();
  }
  if(!pairs||pending)invalid();return boxes;
}
export const VIDEO_FIXTURE_SHA256="99bd1d2cd7c603d33797493620f82377d1dccc7b45269a079f5dc15cd1d4eded";
export function syntheticVideo(runId:string,role:"a"|"b"){
  if(!uuid.test(runId)||!["a","b"].includes(role))invalid();
  const base=Buffer.from(fixture.base64,"base64");
  if(fixture.format!=="immich-mcp-synthetic-video"||fixture.version!==1||fixture.byte_length!==base.length||
    fixture.sha256!==VIDEO_FIXTURE_SHA256||createHash("sha256").update(base).digest("hex")!==VIDEO_FIXTURE_SHA256||
    fixture.width!==320||fixture.height!==180||fixture.duration_seconds<3.4||fixture.duration_seconds>5.5)invalid();
  const boxes=mp4Boxes(base),firstFragment=boxes.findIndex(box=>box.type==="moof");if(firstFragment<2)invalid();
  const init=Buffer.from(base.subarray(0,boxes[firstFragment]!.start));assertVideoInit(init);
  const fragments:Buffer[]=[];
  for(let i=firstFragment;i<boxes.length;i+=2){
    const first=boxes[i]!,last=boxes[i+1];if(first.type!=="moof"||last?.type!=="mdat")invalid();
    const segment=Buffer.from(base.subarray(first.start,last.end));assertVideoFragment(segment);fragments.push(segment);
  }
  // A free box is inert container metadata. Its run/role identity prevents
  // cross-run duplicate uploads while leaving the original encoded frames intact.
  const marker=Buffer.from("immich-mcp-synthetic-video:"+runId+":"+role,"ascii"),free=Buffer.alloc(8+marker.length);
  free.writeUInt32BE(free.length);free.write("free",4,"ascii");marker.copy(free,8);
  const bytes=Buffer.concat([base,free]);
  return {bytes,init,fragments,mime:"video/mp4",filename:"MCP-\u8a66\u9a13-video-"+role+"-"+runId+".mp4",width:320,height:180,
    durationMs:Math.round(fixture.duration_seconds*1000),sha256:createHash("sha256").update(bytes).digest("hex"),sha1:createHash("sha1").update(bytes).digest("base64")};
}
function lines(text:string){
  if(typeof text!=="string"||Buffer.byteLength(text)>128*1024||!text.endsWith("\n")||text.includes("\0"))invalid();
  const result=text.replace(/\r\n/g,"\n").trimEnd().split("\n");
  if(result.length>4096||result[0]!=="#EXTM3U")invalid();return result;
}
export interface HlsVariant {sessionId:string;variantIndex:number;codecs:string;bandwidth:number;width:number;height:number;}
/** Parse the fixed Immich source's relative references without following URLs. */
export function parseVideoMaster(text:string):HlsVariant[]{
  const input=lines(text),variants:HlsVariant[]=[];
  for(let i=1;i<input.length;i++){
    const line=input[i]!;
    if(line.startsWith("#EXT-X-STREAM-INF:")){
      const fields=line.slice(18),bandwidth=/(?:^|,)BANDWIDTH=(\d+)(?:,|$)/.exec(fields),resolution=/(?:^|,)RESOLUTION=(\d+)x(\d+)(?:,|$)/.exec(fields),
        codecs=/(?:^|,)CODECS="([^"]+)"(?:,|$)/.exec(fields),uri=input[++i],
        path=uri&&/^([a-f0-9-]+)\/(0|[1-9]\d*)\/playlist\.m3u8$/.exec(uri);
      if(!bandwidth||!resolution||!codecs||!path||!uuid.test(path[1]!)||!Number.isSafeInteger(Number(path[2])))invalid();
      const variant={sessionId:path[1]!,variantIndex:Number(path[2]),codecs:codecs[1]!,bandwidth:Number(bandwidth[1]),width:Number(resolution[1]),height:Number(resolution[2])};
      if(variant.bandwidth<=0||variant.width<=0||variant.height<=0||variants.some(v=>v.variantIndex===variant.variantIndex)||variants.some(v=>v.sessionId!==variant.sessionId))invalid();
      variants.push(variant);
    }else if(line&&!line.startsWith("#"))invalid();
  }
  if(!variants.length||variants.length>32||!input.includes("#EXT-X-VERSION:7")||!input.includes("#EXT-X-INDEPENDENT-SEGMENTS"))invalid();
  return variants;
}
export function parseVideoPlaylist(text:string){
  const input=lines(text),segments:{filename:string;duration:number}[]=[];
  if(!input.includes('#EXT-X-MAP:URI="init.mp4"')||!input.includes("#EXT-X-VERSION:7")||
    !input.includes("#EXT-X-PLAYLIST-TYPE:VOD")||input.at(-1)!=="#EXT-X-ENDLIST"||
    !input.includes("#EXT-X-MEDIA-SEQUENCE:0")||!input.includes("#EXT-X-TARGETDURATION:2"))invalid();
  for(let i=1;i<input.length;i++){
    const line=input[i]!;
    if(line.startsWith("#EXTINF:")){
      const m=/^#EXTINF:(\d+(?:\.\d+)?),$/.exec(line),filename=input[++i],duration=m?Number(m[1]):NaN;
      if(!Number.isFinite(duration)||duration<=0||duration>2.5||filename!=="seg_"+segments.length+".m4s")invalid();
      segments.push({filename,duration});
    }else if(line&&!line.startsWith("#"))invalid();
  }
  if(!segments.length||segments.length>16)invalid();
  return {init:"init.mp4",segments,duration:segments.reduce((sum,segment)=>sum+segment.duration,0)};
}
