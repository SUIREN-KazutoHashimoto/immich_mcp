import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash,randomBytes } from "node:crypto";
import { DownloadPolicy,publicAddress,type SourceConnector } from "../src/download.js";
import { Staging } from "../src/staging.js";
import { Vault } from "../src/vault.js";
import { prepare } from "../src/serializer.js";

const bytes=Buffer.from([0,255,123,2,10,13,0,128]);
const stream=()=> (async function*(){yield bytes.subarray(0,3);yield bytes.subarray(3);})();
async function fixture(run:(v:Vault,s:Staging)=>Promise<void>,options:any={}) {
  const directory=await mkdtemp(join(tmpdir(),"immich-stage-"));
  const v=new Vault(directory,randomBytes(32),"test",":memory:");
  v.replaceBinding("A","key-A","id-A",0);
  try{await run(v,new Staging(v,new DownloadPolicy([]),options));}
  finally{v.close();await rm(directory,{recursive:true,force:true});}
}
test("attachment policy rejects local, reserved and translated IP addresses",()=>{
  for(const address of ["0.0.0.0","10.0.0.1","100.64.1.1","127.0.0.1","169.254.169.254","172.16.0.1","192.168.1.2","198.18.0.1","224.0.0.1","240.0.0.1","::1","::ffff:127.0.0.1","64:ff9b::7f00:1","fd00::1","fe80::1","2001:db8::1","2002:7f00:1::","3fff::1"])
    assert.equal(publicAddress(address),false,address);
  for(const address of ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"])assert.equal(publicAddress(address),true,address);
  const p=new DownloadPolicy(["files.example.com"]);
  for(const url of ["http://files.example.com/a","https://files.example.com.evil.test/a","https://files.example.com:444/a","https://u:secret@files.example.com/a","https://127.1/a","https://files.example.com./a"])
    assert.throws(()=>p.validate(url),{code:"source_denied"});
});
test("attachment DNS is resolved once and the validated address is passed to the connector",()=>fixture(async(v)=>{
  let lookups=0,closed=false;
  const connect:SourceConnector=async(url,address)=>{
    assert.equal(url.hostname,"files.example.com");
    assert.equal(address.address,"8.8.8.8");assert.equal(address.family,4);
    return {status:200,body:stream(),mime:"application/octet-stream",length:bytes.length,close:()=>{closed=true;}};
  };
  const policy=new DownloadPolicy(["files.example.com"],async()=>{lookups++;return [{address:lookups===1?"8.8.8.8":"127.0.0.1",family:4}];},connect);
  const s=new Staging(v,policy);
  const result=await s.stage("A",[{download_url:"https://files.example.com/photo?token=URL-CANARY",file_id:"f1",file_name:"../photo.bin"}]);
  assert.equal(lookups,1);assert.equal(closed,true);assert.ok(!JSON.stringify(result).includes("URL-CANARY"));
  const part=await s.file("A",result.files[0]!.file_ref);
  assert.deepEqual(Buffer.from(await new Response(part.open() as any).arrayBuffer()),bytes);
  assert.equal(result.files[0]!.sha256,createHash("sha256").update(bytes).digest("hex"));
}));
test("redirect targets and every DNS address are checked before sending",async()=>{
  let sent=0,closed=false;
  const mixed=new DownloadPolicy(["files.example.com"],async()=>[{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}],async()=>{sent++;throw Error();});
  await assert.rejects(mixed.open("https://files.example.com/a"),{code:"source_denied"});assert.equal(sent,0);
  const redirect=new DownloadPolicy(["files.example.com"],async()=>[{address:"8.8.8.8",family:4}],async()=>{
    sent++;return {status:302,body:stream(),location:"https://evil.example/?token=CANARY",close:()=>{closed=true;}};
  });
  await assert.rejects(redirect.open("https://files.example.com/a"),{code:"source_denied"});
  assert.equal(sent,1);assert.equal(closed,true);
});
test("staged references enforce principal, revision and TTL; multipart preserves original bytes",()=>fixture(async(v,s)=>{
  const r=await s.ingest("A","photo.bin","application/octet-stream",stream());
  v.replaceBinding("B","key-B","id-B",0);
  await assert.rejects(s.file("B",r.file_ref),{code:"invalid_reference"});
  const part=await s.file("A",r.file_ref);
  const req=await prepare("http://immich/api",{operation_id:"uploadAsset",body:{fileCreatedAt:"2026-01-01T00:00:00.000Z",fileModifiedAt:"2026-01-01T00:00:00.000Z",isFavorite:false},
    files:{assetData:{file_ref:r.file_ref},sidecarData:{file_ref:r.file_ref}}},
    {file:ref=>s.file("A",ref),secret:async()=>{throw Error();}});
  const form=await new Response(req.body as any,{headers:req.headers}).formData();
  assert.deepEqual(Buffer.from(await (form.get("assetData") as File).arrayBuffer()),bytes);
  assert.deepEqual(Buffer.from(await (form.get("sidecarData") as File).arrayBuffer()),bytes);
  assert.equal(form.get("isFavorite"),"false");
  v.replaceBinding("A","new-key","new-id",1);await assert.rejects(s.file("A",r.file_ref),{code:"invalid_reference"});
  const second=await s.ingest("A","other.bin","application/octet-stream",stream());
  v.db.prepare("UPDATE records SET expires=1 WHERE principal=? AND id=?").run("A",second.file_ref);
  await assert.rejects(s.file("A",second.file_ref),{code:"invalid_reference"});
}));
test("size mismatch, interrupted streams and quotas release reservations and encrypted objects",()=>fixture(async(v,s)=>{
  await assert.rejects(s.ingest("A","x.bin","application/octet-stream",stream(),1),{code:"file_size"});
  const broken=async function*(){yield bytes;throw Error("interrupted");};
  await assert.rejects(s.ingest("A","x.bin","application/octet-stream",broken()));
  assert.equal((v.db.prepare("SELECT COUNT(*) n FROM staging_usage").get() as any).n,0);
  assert.deepEqual(await readdir(join(v.directory,"objects")),[]);
  await s.ingest("A","x.bin","application/octet-stream",stream());
  await assert.rejects(s.ingest("A","y.bin","application/octet-stream",stream()),{code:"staging_quota"});
},{maxFileBytes:8,quotaBytes:8}));
test("concurrent staging reserves quota transactionally before receiving bytes",()=>fixture(async(v,s)=>{
  let release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const slow=async function*(){started();await pending;yield bytes;};
  const first=s.ingest("A","one.bin","application/octet-stream",slow());
  await entered;
  await assert.rejects(s.ingest("A","two.bin","application/octet-stream",stream()),{code:"staging_quota"});
  release();await first;
},{maxFileBytes:8,quotaBytes:8}));
