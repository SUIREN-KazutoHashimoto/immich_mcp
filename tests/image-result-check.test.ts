import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { inspectImageResult } from "../scripts/image-result-check.js";

test("image response probe distinguishes real image content from metadata without returning image or identity data",async()=>{
  const bytes=await sharp({create:{width:32,height:16,channels:3,background:"#2376b8"}}).jpeg().toBuffer();
  const part={type:"image",mimeType:"image/jpeg",data:bytes.toString("base64")};
  const result={content:[part],structuredContent:{result_ref:"PRIVATE-REF"},_meta:{image_content:part}};
  const direct=await inspectImageResult(result),rpc=await inspectImageResult({jsonrpc:"2.0",id:1,result});
  assert.deepEqual(direct,rpc);assert.equal(direct.ok,true);assert.equal(direct.image_parts,1);
  assert.equal(direct.images[0]?.width,32);assert.equal(direct.images[0]?.height,16);assert.equal(direct.images[0]?.bytes,bytes.length);
  assert.ok(!JSON.stringify(direct).includes(part.data));assert.ok(!JSON.stringify(direct).includes("PRIVATE-REF"));
  assert.equal((await inspectImageResult({structuredContent:{width:32,height:16}})).ok,false);
  await assert.rejects(inspectImageResult({content:[{...part,data:"!!!!"}]}),/invalid_image_content/);
  await assert.rejects(inspectImageResult({content:[{...part,data:bytes.subarray(0,Math.floor(bytes.length/2)).toString("base64")}]}));
  await assert.rejects(inspectImageResult({content:[{...part,mimeType:"image/png"}]}),/invalid_image_content/);
});
