import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { BridgeError } from "./types.js";

export const FIXTURE_DATE="2026-01-02T03:04:05.000Z";
function crc32(bytes:Buffer){
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function chunk(type:string,data:Buffer){
  const header=Buffer.alloc(8),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);header.write(type,4,4,"ascii");
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type,"ascii"),data])));return Buffer.concat([header,data,tail]);
}
export function syntheticPhoto(runId:string,role:"a"|"private_a"|"b"|"locked_a"|"link_a"|"auth_b"|"sync_a"|"sync_b"|"collection_a1"|"collection_a2"|"collection_a3"|"collection_a4"|"collection_b1"|"collection_b2"|"sharing_album_a"|"sharing_private_a"|"sharing_download_a"|"sharing_b"|"profile_a_first"|"profile_a_final"|"profile_b"|"discovery_a_shared"|"discovery_a_private"|"discovery_b"|"people_a1"|"people_a2"|"people_b1"|"lifecycle_a1"|"lifecycle_a2"|"lifecycle_a3"|"lifecycle_a4"|"lifecycle_a5"|"lifecycle_a6"|"lifecycle_b1"|"workflow_a1"|"workflow_a2"|"workflow_b1"|"lifecycle_b2"){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)||!["a","private_a","b","locked_a","link_a","auth_b","sync_a","sync_b","collection_a1","collection_a2","collection_a3","collection_a4","collection_b1","collection_b2","sharing_album_a","sharing_private_a","sharing_download_a","sharing_b","profile_a_first","profile_a_final","profile_b","discovery_a_shared","discovery_a_private","discovery_b","people_a1","people_a2","people_b1","lifecycle_a1","lifecycle_a2","lifecycle_a3","lifecycle_a4","lifecycle_a5","lifecycle_a6","lifecycle_b1","workflow_a1","workflow_a2","workflow_b1","lifecycle_b2"].includes(role))throw new BridgeError("fixture_media","Invalid synthetic media identity");
  const seed=createHash("sha256").update(runId+":"+role).digest(),width=64,height=32,rows=Buffer.alloc(height*(1+width*3));
  for(let y=0;y<height;y++){
    const row=y*(1+width*3);rows[row]=0;
    for(let x=0;x<width;x++)for(let c=0;c<3;c++)rows[row+1+x*3+c]=(seed[(x+y+c)%seed.length]!+x*3+y*7+c*31)&255;
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
  const sidecar=Buffer.from('<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">MCP synthetic '+role+' '+runId+'</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',"utf8");
  return {filename:"MCP-\u8a66\u9a13-"+role+"-"+runId+".png",mime:"image/png",bytes,sidecar,width,height,
    sha256:createHash("sha256").update(bytes).digest("hex"),sha1:createHash("sha1").update(bytes).digest("base64"),
    sidecarSha256:createHash("sha256").update(sidecar).digest("hex")};
}
