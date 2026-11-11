import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {version,compare,channelCandidates,publicationVersion,Registry,prepareVersion,inspectImage,refreshChannels,verifyStableTag,type Docker} from "../scripts/container-channels.js";
const repository="SUIREN-KazutoHashimoto/immich_mcp",image="ghcr.io/suiren-kazutohashimoto/immich-mcp",revision="a".repeat(40);
const digest=(x:string)=>"sha256:"+x.repeat(64);
const release=(v:string,prerelease=false,draft=false)=>({tag_name:"v"+v,prerelease,draft});
test("numeric versions keep stable and beta separate and reject ambiguous tags",()=>{
 assert.ok(compare(version("1.0.0-beta.10")!,version("1.0.0-beta.9")!)>0);
 assert.ok(compare(version("1.10.0")!,version("1.9.99")!)>0);
 assert.ok(compare(version("1.0.0")!,version("1.0.0-beta.99")!)>0);
 for(const x of ["stable","latest","v1.0.0","01.0.0","1.0.0-beta.0","1.0.0-beta.01","1.0.0-rc.1","1.0.0+build","1.0","1.0.0\n"])assert.equal(version(x),null,x);
 const c=channelCandidates(["1.0.0-beta.9","1.0.0-beta.10","1.0.0","2.0.0","stable"],[release("1.0.0"),release("2.0.0",false,true)]);
 assert.equal(c.beta?.version,"1.0.0-beta.10");assert.equal(c.stable?.version,"1.0.0");
 assert.equal(channelCandidates(["1.0.0"],[release("1.0.0",true)]).stable,undefined);
});
test("release events must match package version, state and prerelease flag",()=>{
 for(const v of ["1.0.0","1.1.0-beta.1"])assert.equal(publicationVersion(v,{action:"published",release:release(v,v.includes("beta"))},revision).version,v);
 assert.equal(publicationVersion("1.0.0-beta.3",{},revision).channel,"beta");
 for(const e of [{action:"created",release:release("1.0.0")},{action:"published",release:release("1.0.1")},{action:"published",release:release("1.0.0",true)},{action:"published",release:release("1.0.0",false,true)}])assert.throws(()=>publicationVersion("1.0.0",e,revision));
 assert.throws(()=>publicationVersion("1.0.0",{},"bad"));
});
test("registry pagination and HEAD digests cross real HTTP without leaking error bodies",async()=>{
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,"Bearer registry-canary");
  if(req.url?.includes("/tags/list")){
   if(!req.url.includes("last="))res.setHeader("link",'</v2/suiren-kazutohashimoto/immich-mcp/tags/list?n=100&last=old>; rel="next"');
   res.end(JSON.stringify({name:"suiren-kazutohashimoto/immich-mcp",tags:[req.url.includes("last=")?"1.0.0-beta.3":"1.0.0-beta.2"]}));return;
  }
  if(req.url?.endsWith("/beta")){res.setHeader("docker-content-digest",digest("a"));res.end();return;}
  res.writeHead(req.url?.endsWith("/bad")?500:404);res.end("PRIVATE-ERROR-CANARY");
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");
 try{
  const r=new Registry(image,"registry-canary",fetch,"http://127.0.0.1:"+(server.address() as any).port);
  assert.deepEqual(await r.tags(),["1.0.0-beta.2","1.0.0-beta.3"]);assert.equal(await r.digest("beta"),digest("a"));assert.equal(await r.digest("stable"),null);
  await assert.rejects(r.digest("bad"),e=>!String(e).includes("CANARY")&&!String(e).includes("registry-canary"));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test("registry pagination rejects external bearer destinations and loops",async()=>{
 for(const link of ['<https://evil.example/v2/suiren-kazutohashimoto/immich-mcp/tags/list>; rel="next"','</v2/suiren-kazutohashimoto/immich-mcp/tags/list?n=100>; rel="next"']){
  let count=0;const request:typeof fetch=async()=>{count++;return Response.json({name:"suiren-kazutohashimoto/immich-mcp",tags:[]},{headers:{link}});};
  await assert.rejects(new Registry(image,"SECRET",request).tags());assert.equal(count,1);
 }
});
function fixture(tags=["1.0.0","1.1.0-beta.2","1.1.0-beta.10"]){
 const digests=new Map(tags.map((v,i)=>[v,digest(String(i+1))])),versions=new Map([...digests].map(([v,d])=>[d,v])),calls:string[][]=[],local=new Map<string,string>();
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(init?.redirect,"error");
  if(url.hostname==="api.github.com")return Response.json({object:{type:"commit",sha:revision}});
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer registry-token");
  if(url.pathname.endsWith("/tags/list"))return Response.json({name:"suiren-kazutohashimoto/immich-mcp",tags});
  const d=digests.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
  return new Response(null,{status:d?200:404,headers:d?{"docker-content-digest":d}:{}});
 };
 const run:Docker=args=>{
  calls.push(args);
  if(args[0]==="image")return JSON.stringify([{Os:"linux",Architecture:"amd64",Config:{User:"1000:1000",Labels:{"org.opencontainers.image.version":versions.get(args.at(-1)!.split("@")[1]!),"org.opencontainers.image.source":"https://github.com/"+repository,"org.opencontainers.image.revision":revision}}}]);
  if(args[0]==="tag")local.set(args[2]!,args[1]!.split("@")[1]!);
  if(args[0]==="push")digests.set(args[1]!.split(":").at(-1)!,local.get(args[1]!)!);
  return "";
 };
 const registry=new Registry(image,"registry-token",request);
 return {registry,run,digests,versions,calls,options:{registry,run,repository,token:"github-token",releases:[release("1.0.0")],runs:[{head_sha:revision,conclusion:"success",event:"workflow_dispatch"}],dryRun:false,request}};
}
test("only stable/beta aliases change and their digests match the verified fixed versions",async()=>{
 const f=fixture(),before=[...f.digests],r=await refreshChannels(f.options);
 assert.equal(r.find(x=>x.channel==="stable").version,"1.0.0");assert.equal(r.find(x=>x.channel==="beta").version,"1.1.0-beta.10");
 for(const [v,d]of before)assert.equal(f.digests.get(v),d);
 assert.equal(f.digests.get("stable"),f.digests.get("1.0.0"));assert.equal(f.digests.get("beta"),f.digests.get("1.1.0-beta.10"));
 assert.deepEqual(f.calls.filter(c=>c[0]==="push").map(c=>c[1]),[image+":stable",image+":beta"]);
 const n=f.calls.length;assert.ok((await refreshChannels(f.options)).every(x=>x.status==="unchanged"));assert.equal(f.calls.length,n);
});
test("dry run validates without publishing and old completions never downgrade channels",async()=>{
 const f=fixture();assert.ok((await refreshChannels({...f.options,dryRun:true})).every(x=>x.status==="dry_run"));
 assert.ok(!f.calls.some(c=>["tag","push"].includes(c[0]!)));
 const old=fixture(["1.0.0-beta.3"]);old.digests.set("beta",digest("f"));old.versions.set(digest("f"),"1.0.0-beta.10");
 const r=await refreshChannels({...old.options,releases:[]});assert.equal(r[0].status,"no_eligible_version");assert.equal(r[1].status,"newer_channel_preserved");assert.ok(!old.calls.some(c=>c[0]==="push"));
});
test("missing CI proof, wrong source and a mismatched stable release cannot be promoted",async()=>{
 const f=fixture();await assert.rejects(refreshChannels({...f.options,runs:[]}));assert.ok(!f.calls.some(c=>c[0]==="push"));
 const wrong:Docker=()=>JSON.stringify([{Os:"linux",Architecture:"amd64",Config:{User:"1000:1000",Labels:{"org.opencontainers.image.version":"1.0.0","org.opencontainers.image.source":"https://github.com/evil/repo","org.opencontainers.image.revision":revision}}}]);
 assert.throws(()=>inspectImage(wrong,image+":1.0.0","1.0.0",repository));
 const request:typeof fetch=async()=>Response.json({object:{type:"commit",sha:"b".repeat(40)}});
 await assert.rejects(refreshChannels({...fixture().options,request}));
});
test("fixed version reuse requires the exact source and never overwrites the remote version",async()=>{
 const f=fixture(["1.0.0-beta.3"]);assert.equal((await prepareVersion(f.registry,f.run,"1.0.0-beta.3",repository,revision)).reuse,true);
 assert.ok(!f.calls.some(c=>c[0]==="push"));
 await assert.rejects(prepareVersion(f.registry,f.run,"1.0.0-beta.3",repository,"b".repeat(40)));
 assert.equal((await prepareVersion(f.registry,f.run,"1.0.0-beta.4",repository,revision)).reuse,false);
});
test("annotated stable tags are peeled and cyclic chains are rejected",async()=>{
 let i=0;const request:typeof fetch=async()=>Response.json({object:++i===1?{type:"tag",sha:"c".repeat(40)}:{type:"commit",sha:revision}});
 await verifyStableTag(repository,"TOKEN","v1.0.0",revision,request);assert.equal(i,2);
 await assert.rejects(verifyStableTag(repository,"TOKEN","v1.0.0",revision,async()=>Response.json({object:{type:"tag",sha:"c".repeat(40)}})));
});
