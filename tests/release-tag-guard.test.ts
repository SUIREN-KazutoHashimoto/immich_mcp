import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {verifyReleaseTag} from "../scripts/release-tag-guard.js";
const sha="1".repeat(40),annotation="2".repeat(40),tag="v1.0.0-beta.1",path="/git/ref/tags/"+tag;
const ref=(type:string,target:string)=>({ref:"refs/tags/"+tag,object:{type,sha:target}});
test("a never-created tag is checked through the real reference HTTP route and accepts404, without using commit lookup422",async()=>{
  const seen:string[]=[];
  const server=createServer((req,res)=>{seen.push(req.url!);res.writeHead(req.url===path?404:422);res.end();});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const base="http://127.0.0.1:"+(server.address()as any).port;
    assert.equal(await verifyReleaseTag(p=>fetch(base+p),tag,sha),"absent");assert.deepEqual(seen,[path]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test("existing lightweight and annotated tags must resolve to the exact source commit",async()=>{
  assert.equal(await verifyReleaseTag(async()=>Response.json(ref("commit",sha)),tag,sha),"matching");
  const calls:string[]=[];
  assert.equal(await verifyReleaseTag(async p=>{calls.push(p);return Response.json(p===path?ref("tag",annotation):{sha:annotation,object:{type:"commit",sha}});},tag,sha),"matching");
  assert.deepEqual(calls,[path,"/git/tags/"+annotation]);
});
test("a published name cannot be silently moved to another commit or to a non-commit object",async()=>{
  await assert.rejects(verifyReleaseTag(async()=>Response.json(ref("commit","3".repeat(40))),tag,sha),/different source commit/);
  await assert.rejects(verifyReleaseTag(async()=>Response.json(ref("tree",sha)),tag,sha),/commit\/tag/);
  await assert.rejects(verifyReleaseTag(async()=>Response.json({...ref("commit",sha),ref:"refs/tags/other"}),tag,sha),/different reference/);
});
test("API errors, missing annotations and cyclic chains remain hard failures rather than absent tags",async()=>{
  for(const status of [401,403,422,429,500])await assert.rejects(verifyReleaseTag(async()=>new Response(null,{status}),tag,sha),/Unexpected GitHub reference response/);
  await assert.rejects(verifyReleaseTag(async p=>p===path?Response.json(ref("tag",annotation)):new Response(null,{status:404}),tag,sha),/annotated-tag response/);
  await assert.rejects(verifyReleaseTag(async p=>Response.json(p===path?ref("tag",annotation):{sha:annotation,object:{type:"tag",sha:annotation}}),tag,sha),/chain exceeded/);
});
