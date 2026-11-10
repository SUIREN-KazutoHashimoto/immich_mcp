import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { profileImageFrame } from "../src/integration-profile-image.js";

test("independent Pillow progressive JPEG and WebP data has bounded frames and decodes to expected pixels in a real browser",async()=>{
  const oracle=JSON.parse(await readFile(join(process.cwd(),"tests","profile-image-oracle.json"),"utf8"));
  assert.match(oracle.producer,/^Python Pillow /);assert.equal(oracle.entries.length,6);
  for(const item of oracle.entries){
    const bytes=Buffer.from(item.base64,"base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"),item.sha256);
    assert.deepEqual(profileImageFrame(bytes,item.mime),{format:item.mime.split("/")[1],width:64,height:32});
  }
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  try{
    const page=await browser.newPage();
    const decoded:any=await page.evaluate(String.raw`(async(entries)=>{
      const results=[];
      for(const item of entries){
        const image=new Image();image.src="data:"+item.mime+";base64,"+item.base64;await image.decode();
        const canvas=document.createElement("canvas");canvas.width=64;canvas.height=32;const context=canvas.getContext("2d");context.drawImage(image,0,0);
        results.push({width:image.naturalWidth,height:image.naturalHeight,rgb:Array.from(context.getImageData(32,16,1,1).data).slice(0,3)});
      }return results;
    })(`+JSON.stringify(oracle.entries)+")");
    for(let i=0;i<decoded.length;i++){
      assert.equal(decoded[i].width,64);assert.equal(decoded[i].height,32);
      assert.ok(decoded[i].rgb.every((v:number,c:number)=>Math.abs(v-oracle.entries[i].center_rgb[c])<=12));
    }
  }finally{await browser.close();}
});
test("profile frame inspection rejects truncated or mismatched containers, invalid sizes and animation",async()=>{
  const oracle=JSON.parse(await readFile(join(process.cwd(),"tests","profile-image-oracle.json"),"utf8"));
  const jpeg=Buffer.from(oracle.entries.find((x:any)=>x.mime==="image/jpeg").base64,"base64");
  const webp=Buffer.from(oracle.entries.find((x:any)=>x.mime==="image/webp").base64,"base64");
  for(const [bytes,mime] of [[jpeg.subarray(0,-1),"image/jpeg"],[Buffer.concat([jpeg,Buffer.from([0])]),"image/jpeg"],[webp.subarray(0,-1),"image/webp"],[jpeg,"image/webp"],[webp,"image/jpeg"],[Buffer.alloc(1024*1024+1),"image/jpeg"],[Buffer.alloc(10),"image/jpeg"]] as const)assert.throws(()=>profileImageFrame(bytes,mime),/profile image/);
  const badRiff=Buffer.from(webp);badRiff.writeUInt32LE(0xffffffff,4);assert.throws(()=>profileImageFrame(badRiff,"image/webp"));
  const animated=Buffer.from(webp);animated.write("ANIM",12,"ascii");assert.throws(()=>profileImageFrame(animated,"image/webp"));
  const badLength=Buffer.from(jpeg);badLength.writeUInt16BE(65535,4);assert.throws(()=>profileImageFrame(badLength,"image/jpeg"));
});
