import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { writeFile,realpath } from "node:fs/promises";
import { isAbsolute,dirname,basename,join,resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { BridgeError } from "../src/types.js";

export async function generateVideoFixture(destination:string){
  if(!isAbsolute(destination))throw new BridgeError("fixture_destination","Use a new absolute JSON destination");
  const output=join(await realpath(dirname(destination)),basename(destination));
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  const deadline=setTimeout(()=>void browser.close(),45000);
  try{
    const page=await browser.newPage();
    await page.route("**/*",route=>route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Synthetic fixture encoder</title>"}));
    await page.goto("http://127.0.0.1/synthetic-video");
    const generated=await page.evaluate(String.raw`(async()=>{
      const width=320,height=180,frames=40,fps=10,mime="video/mp4;codecs=avc1.42001E";
      if(!isSecureContext||!MediaRecorder.isTypeSupported(mime))throw Error("MP4/H264 recording unavailable");
      const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;document.body.append(canvas);
      const ctx=canvas.getContext("2d"),stream=canvas.captureStream(0),track=stream.getVideoTracks()[0];
      const chunks=[];const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:192000});
      const stopped=new Promise((accept,reject)=>{recorder.onstop=()=>accept();recorder.onerror=()=>reject(Error("Recording failed"));});
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      // A canvas with manual frame delivery may not start the encoder until its
      // first frame arrives. Queue frames immediately after the synchronous start.
      recorder.start(1000);
      const colors=["rgb(240,32,32)","rgb(32,224,64)","rgb(32,64,240)","rgb(224,224,32)"],start=performance.now();
      for(let frame=0;frame<frames;frame++){
        ctx.fillStyle=colors[Math.floor(frame/10)];ctx.fillRect(0,0,width,height);
        ctx.fillStyle="white";ctx.fillRect((frame*7)%(width-12),height/2,8,8);track.requestFrame();
        await new Promise(accept=>setTimeout(accept,Math.max(1,start+(frame+1)*1000/fps-performance.now())));
      }
      recorder.stop();await Promise.race([stopped,new Promise((_,reject)=>setTimeout(()=>reject(Error("Recorder stop timeout")),10000))]);track.stop();
      const blob=new Blob(chunks,{type:"video/mp4"});if(blob.size>1024*1024)throw Error("Fixture exceeds bound");
      const video=document.createElement("video");video.muted=true;video.preload="auto";document.body.append(video);
      const event=(name)=>new Promise((accept,reject)=>{
        const timer=setTimeout(()=>reject(Error("Decode event timeout")),10000);
        video.addEventListener(name,()=>{clearTimeout(timer);accept();},{once:true});
        video.addEventListener("error",()=>{clearTimeout(timer);reject(Error("Video decode failed"));},{once:true});
      });
      const objectUrl=URL.createObjectURL(blob);const loaded=event("loadeddata");video.src=objectUrl;video.load();await loaded;
      if(video.videoWidth!==width||video.videoHeight!==height||!Number.isFinite(video.duration)||video.duration<3.4||video.duration>5.5)
        throw Error("Invalid recorded dimensions/duration");
      const firstSeek=event("seeked");video.currentTime=0.2;await firstSeek;
      ctx.drawImage(video,0,0,width,height);const first=[...ctx.getImageData(15,15,1,1).data];
      const laterSeek=event("seeked");video.currentTime=2.5;await laterSeek;
      ctx.drawImage(video,0,0,width,height);const later=[...ctx.getImageData(15,15,1,1).data];
      if(!(first[0]>first[2]+100&&later[2]>later[0]+100))throw Error("Synthetic color frames did not decode");
      const duration=video.duration;video.removeAttribute("src");video.load();URL.revokeObjectURL(objectUrl);
      return {width,height,frames,nominal_fps:fps,duration_seconds:duration,recorder_mime:recorder.mimeType,first_pixel:first,later_pixel:later,bytes:[...new Uint8Array(await blob.arrayBuffer())]};
    })()`) as {width:number;height:number;frames:number;nominal_fps:number;duration_seconds:number;recorder_mime:string;first_pixel:number[];later_pixel:number[];bytes:number[]};
    const bytes=Buffer.from(generated.bytes);const {bytes:_bytes,...metadata}=generated;
    const types:string[]=[];let offset=0;
    while(offset<bytes.length){const size=bytes.readUInt32BE(offset);if(size<8||offset+size>bytes.length)throw Error("Invalid generated MP4 box");types.push(bytes.toString("ascii",offset+4,offset+8));offset+=size;}
    if(!types.includes("ftyp")||!types.includes("moov")||!types.includes("moof")||!types.includes("mdat"))throw Error("Expected fragmented MP4 fixture");
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const fixture={format:"immich-mcp-synthetic-video",version:1,mime:"video/mp4",...metadata,byte_length:bytes.length,sha256,
      generator:{script:"scripts/generate-video-fixture.ts",browser:browser.version(),source:"Programmatic color frames and moving square; no camera, screen, external assets or audio"},top_level_boxes:types,base64:bytes.toString("base64")};
    await writeFile(output,JSON.stringify(fixture,null,2)+"\n",{flag:"wx"});
    return {output,sha256,bytes:bytes.length,width:metadata.width,height:metadata.height,duration_seconds:metadata.duration_seconds,top_level_boxes:types};
  }finally{clearTimeout(deadline);await browser.close().catch(()=>{});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values}=parseArgs({allowPositionals:false,strict:true,options:{output:{type:"string"}}});
  generateVideoFixture(values.output??"").then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(JSON.stringify({error:{code:error instanceof BridgeError?error.code:"fixture_generation_failed",message:error instanceof Error?error.message:"Generation failed"}}));process.exitCode=1;
  });
}
