import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Control } from "../src/control.js";
import { Contexts } from "../src/contexts.js";
import { AccessAuth } from "../src/access.js";
import { Images,type ImageTrace } from "../src/images.js";
import { uuid } from "./fixtures.js";

async function setup(run:(s:{v:Vault;images:Images;contexts:Contexts;trace:ImageTrace[];save:(bytes:Buffer,options?:any)=>Promise<string>})=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-image-")),key=randomBytes(32),v=new Vault(dir,key,"image-test",":memory:");
  const executor=new Executor("http://immich/api",v,async()=>{throw Error("Reading a result must never call upstream");});
  const contexts=new Contexts(v,executor,"https://mcp.example.test");
  const access=new AccessAuth({issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"});
  const control=new Control(access,v,executor,key,undefined,undefined,undefined,contexts),trace:ImageTrace[]=[],images=new Images(v,control,e=>trace.push({...e}));
  v.replaceBinding("A","KEY-CANARY",uuid,0);v.replaceBinding("B","OTHER-KEY",uuid,0);
  const save=async(bytes:Buffer,options:any={})=>{
    const expires=options.expires ?? Date.now()+3600000;
    const captured=await v.capture("A",(async function*(){yield bytes;})(),Math.max(1,bytes.length),undefined,expires);
    const raw={...captured,content_encoding:options.encoding ?? "identity"};
    return v.put("A","result",{revision:v.resourceRevision("A"),display:{operation_id:"viewAsset",state:"completed",
      upstream:{status:200,content_type:options.mime ?? "image/jpeg"},data:null,...options.display},raw,...options.record},expires);
  };
  try{await run({v,images,contexts,trace,save});}
  finally{await executor.close();v.close();await rm(dir,{recursive:true,force:true});}
}
const jpeg=()=>sharp({create:{width:80,height:40,channels:3,background:"#0088cc"}}).jpeg().toBuffer();

test("orients, resizes and strips EXIF/GPS/XMP without changing the encrypted original",()=>setup(async({v,images,save,trace})=>{
  const source=await sharp({create:{width:80,height:40,channels:3,background:"#0088cc"}}).jpeg().withExif({
    IFD0:{Orientation:"6",Artist:"PERSON-CANARY"},IFD3:{GPSLatitudeRef:"N",GPSLatitude:"35/1 0/1 0/1",GPSLongitudeRef:"E",GPSLongitude:"139/1 0/1 0/1"}
  }).withXmp('<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><private>GPS-CANARY</private></x:xmpmeta>').withMetadata({orientation:6}).toBuffer();
  assert.ok((await sharp(source).metadata()).exif);assert.equal((await sharp(source).metadata()).orientation,6);
  const ref=await save(source),reply=await images.read("A",{result_ref:ref,max_width:20,max_height:40});
  const part=reply.content[0];assert.ok(part);assert.equal(part.type,"image");assert.ok("data" in part);
  const bytes=Buffer.from((part as {data:string}).data,"base64"),meta=await sharp(bytes).metadata();
  assert.equal(meta.width,20);assert.equal(meta.height,40);assert.equal(meta.exif,undefined);assert.equal(meta.xmp,undefined);assert.equal(meta.icc,undefined);
  assert.equal(reply._meta.image_info.metadata_removed,true);assert.equal(reply._meta.image_info.size_bytes,bytes.length);
  const stored=v.get("A",ref,"result"),parts:Buffer[]=[];for await(const chunk of v.rawStream("A",stored.raw.raw_ref))parts.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(parts),source);
  const logs=JSON.stringify(trace);for(const secret of [ref,"PERSON-CANARY","GPS-CANARY","KEY-CANARY","image/jpeg;base64"])assert.ok(!logs.includes(secret));
  assert.equal(trace.at(-1)?.content_type,"image");
}));

test("PNG transparency and WebP are decoded as raster images and emitted in the requested format",()=>setup(async({images,save})=>{
  const png=await sharp({create:{width:12,height:8,channels:4,background:{r:255,g:0,b:0,alpha:0}}}).png().toBuffer();
  const ref=await save(png,{mime:"image/png"}),reply=await images.read("A",{result_ref:ref});
  const rgb=await sharp(Buffer.from((reply.content[0] as {data:string}).data,"base64")).raw().toBuffer();
  assert.ok([...rgb].every(value=>value>=250),"Transparent pixels should be flattened on white");
  const webp=await sharp(await jpeg()).webp().toBuffer(),other=await images.read("A",{result_ref:await save(webp,{mime:"image/webp"}),format:"webp"});
  assert.equal(other._meta.image_info.mime_type,"image/webp");assert.equal(other._meta.image_info.width,80);
}));

test("keeps large noisy images within the output byte budget by shrinking them",()=>setup(async({images,save})=>{
  const png=await sharp(randomBytes(2048*2048*3),{raw:{width:2048,height:2048,channels:3}}).png().toBuffer();
  const reply=await images.read("A",{result_ref:await save(png,{mime:"image/png"}),max_width:2048,max_height:2048});
  assert.ok(reply._meta.image_info.size_bytes<=1024*1024);assert.ok(reply._meta.image_info.width<=1024);
}));

test("rejects missing, foreign, expired, rotated and disconnected references",()=>setup(async({v,images,save})=>{
  const ref=await save(await jpeg());
  for(const bad of ["not-a-result","result_"+randomUUID()])await assert.rejects(images.read("A",{result_ref:bad}),{code:"invalid_reference"});
  await assert.rejects(images.read("B",{result_ref:ref}),{code:"invalid_reference"});
  const expired=await save(await jpeg());v.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(expired);
  await assert.rejects(images.read("A",{result_ref:expired}),{code:"image_reference_expired"});
  v.replaceBinding("A","NEW-KEY",uuid,1);
  await assert.rejects(images.read("A",{result_ref:ref}),{code:"image_reference_forbidden"});
  const fresh=await save(await jpeg());v.disconnect("A",2);
  await assert.rejects(images.read("A",{result_ref:fresh}),{code:"image_reference_forbidden"});
}));

test("enforces explicit context ownership and revocation",()=>setup(async({images,contexts,save})=>{
  const context=await contexts.register("A",{kind:"public",acknowledge:true});
  const ref=await save(await jpeg(),{record:{context_ref:context.context_ref,context_generation:context.generation}});
  assert.equal((await images.read("A",{result_ref:ref}))._meta.image_info.mime_type,"image/jpeg");
  await assert.rejects(images.read("B",{result_ref:ref}),{code:"invalid_reference"});
  contexts.revoke("A",context.context_ref,context.generation);
  await assert.rejects(images.read("A",{result_ref:ref}),{code:"image_reference_forbidden"});
}));

test("rechecks authorization after an asynchronous raw read",()=>setup(async({v,images,save})=>{
  const ref=await save(await jpeg()),original=v.rawStream.bind(v);
  v.rawStream=(principal,id)=>Readable.from((async function*(){v.replaceBinding("A","ROTATED-DURING-READ",uuid,1);for await(const chunk of original(principal,id))yield chunk;})());
  await assert.rejects(images.read("A",{result_ref:ref}),{code:"image_reference_forbidden"});
}));

test("rejects unsupported MIME, MIME mismatch, corrupt images and incomplete results",()=>setup(async({v,images,save})=>{
  const bytes=await jpeg();
  for(const mime of ["image/svg+xml","image/gif","application/octet-stream","text/html"])
    await assert.rejects(images.read("A",{result_ref:await save(bytes,{mime})}),{code:"image_unsupported_mime"});
  await assert.rejects(images.read("A",{result_ref:await save(bytes,{mime:"image/png"})}),{code:"image_mime_mismatch"});
  await assert.rejects(images.read("A",{result_ref:await save(Buffer.from([0xff,0xd8,0xff,0,1,2]))}),{code:"image_decode_failed"});
  for(const display of [{state:"outcome_unknown"},{upstream:{status:206,content_type:"image/jpeg"}},{state:"failed"}])
    await assert.rejects(images.read("A",{result_ref:await save(bytes,{display})}),{code:"image_result_incomplete"});
  const ref=await save(bytes),record=v.get("A",ref,"result");record.raw.interrupted=true;v.put("A","result",record,Date.now()+60000,ref);
  await assert.rejects(images.read("A",{result_ref:ref}),{code:"image_result_incomplete"});
}));

test("bounds compressed input, wire size and declared pixel dimensions before returning data",()=>setup(async({v,images,save})=>{
  const compressed=await save(gzipSync(await jpeg()),{encoding:"gzip"});
  assert.equal((await images.read("A",{result_ref:compressed}))._meta.image_info.width,80);
  const bomb=await save(gzipSync(Buffer.alloc(32*1024*1024+1)),{encoding:"gzip"});
  await assert.rejects(images.read("A",{result_ref:bomb}),{code:"image_size_exceeded"});
  const tooBig=await save(await jpeg()),record=v.get("A",tooBig,"result"),raw=v.get("A",record.raw.raw_ref,"raw");
  record.raw.size=raw.size=32*1024*1024+1;v.put("A","raw",raw,Date.now()+60000,record.raw.raw_ref);v.put("A","result",record,Date.now()+60000,tooBig);
  await assert.rejects(images.read("A",{result_ref:tooBig}),{code:"image_size_exceeded"});
  const pixels=await sharp({create:{width:1,height:1,channels:3,background:"red"}}).png().toBuffer();
  pixels.writeUInt32BE(100000,16);pixels.writeUInt32BE(100000,20);
  let crc=0xffffffff;for(const byte of pixels.subarray(12,29)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  pixels.writeUInt32BE((crc^0xffffffff)>>>0,29);
  await assert.rejects(images.read("A",{result_ref:await save(pixels,{mime:"image/png"})}),{code:"image_size_exceeded"});
}));

test("bounds simultaneous reads and releases slots and vault pins after cancellation",()=>setup(async({v,images,save})=>{
  const ref=await save(await jpeg()),original=v.rawStream.bind(v);
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});
  v.rawStream=(principal,id)=>Readable.from((async function*(){await hold;for await(const chunk of original(principal,id))yield chunk;})());
  const one=images.read("A",{result_ref:ref}),two=images.read("A",{result_ref:ref});
  try{await assert.rejects(images.read("A",{result_ref:ref}),{code:"image_busy"});}finally{release();}
  await Promise.all([one,two]);v.rawStream=original;
  await assert.rejects(images.read("A",{result_ref:ref},AbortSignal.abort()),{code:"image_cancelled"});
  assert.equal((await images.read("A",{result_ref:ref}))._meta.image_info.width,80);
  assert.equal(v.isPinned("A",ref),false);
}));

test("validates image options and never logs raw data, identity, references or native errors",()=>setup(async({images,save,trace})=>{
  const ref=await save(await jpeg());
  for(const options of [{max_width:2049},{max_height:0},{max_width:NaN},{format:"svg"},{extra:"TOKEN-CANARY"}])
    await assert.rejects(images.read("A",{result_ref:ref,...options} as any));
  const bad=await save(Buffer.from("CORRUPT-PRIVATE-DATA-CANARY"));
  const error:any=await images.read("A",{result_ref:bad}).catch(e=>e);
  assert.equal(error.code,"image_decode_failed");assert.match(error.requestId,/^img_/);
  const logs=JSON.stringify(trace);
  for(const value of [ref,bad,"CORRUPT-PRIVATE-DATA-CANARY","TOKEN-CANARY","KEY-CANARY",'"principal"','"user"'])assert.ok(!logs.includes(value));
  assert.ok(trace.some(e=>e.request_id===error.requestId&&e.stage==="decode"&&e.code==="image_decode_failed"));
}));

test("cancelling an in-progress read releases its slot and active vault objects",()=>setup(async({v,images,save})=>{
  const ref=await save(await jpeg()),original=v.rawStream.bind(v),controller=new AbortController();
  v.rawStream=(principal,id)=>Readable.from((async function*(){controller.abort();for await(const chunk of original(principal,id))yield chunk;})());
  await assert.rejects(images.read("A",{result_ref:ref},controller.signal),{code:"image_cancelled"});
  v.rawStream=original;
  assert.equal((await images.read("A",{result_ref:ref}))._meta.image_info.width,80);
  assert.equal(v.isPinned("A",ref),false);
}));
