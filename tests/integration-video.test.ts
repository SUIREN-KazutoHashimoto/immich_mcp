import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,rm,readFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { fixtureServerId,withInitializedFixtureLab } from "../src/integration-bootstrap.js";
import { createVideoFixtures,VIDEO_PLAN } from "../src/integration-video-fixtures.js";
import { syntheticVideo,mp4Boxes,assertVideoInit,assertVideoFragment,parseVideoMaster,parseVideoPlaylist } from "../src/integration-video-media.js";
import { IntegrationRun } from "../src/integration-run.js";
import { Vault } from "../src/vault.js";
import { BridgeError } from "../src/types.js";
import { setup,state,fakeDocker } from "./lab-harness.js";
import { seedHarnessAccounts } from "./media-harness.js";
import { videoBackend } from "./video-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return vault.get("__integration_feature_runs",VIDEO_PLAN,"fixture_run");}finally{vault.close();}
}
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),backend=videoBackend();
  await upLab(root,{docker:runner,http:backend.http});await seedHarnessAccounts(root,backend.backend);return {base,root,runner,...backend};
}
describe("isolated video scenarios",{concurrency:3},()=>{
test("synthetic video identities preserve encoded frames and bounded MP4 framing rejects invalid input",()=>{
  const id=randomUUID(),a=syntheticVideo(id,"a"),b=syntheticVideo(id,"b");
  assert.deepEqual(a.bytes,syntheticVideo(id,"a").bytes);assert.notEqual(a.sha256,b.sha256);assert.notEqual(a.sha256,syntheticVideo(randomUUID(),"a").sha256);
  assert.match(a.filename,/\u8a66\u9a13/);assert.deepEqual(a.init,b.init);assert.equal(a.fragments.length,2);assertVideoInit(a.init);for(const f of a.fragments)assertVideoFragment(f);
  assert.equal(mp4Boxes(a.bytes).at(-1)?.type,"free");assert.throws(()=>syntheticVideo("untrusted","a"),isCode("fixture_video"));
  for(const bytes of [Buffer.alloc(0),Buffer.from([0,0,0]),Buffer.from([0,0,0,7,102,116,121,112]),Buffer.from([0,0,0,20,102,116,121,112]),Buffer.from([0,0,0,1,102,116,121,112]),Buffer.concat([a.init,Buffer.from([1])])])
    assert.throws(()=>mp4Boxes(bytes),isCode("fixture_video"));
  assert.throws(()=>assertVideoInit(a.fragments[0]!),isCode("fixture_video"));assert.throws(()=>assertVideoFragment(a.init),isCode("fixture_video"));
  const wide=Buffer.alloc(16);wide.writeUInt32BE(1);wide.write("free",4);wide.writeBigUInt64BE(16n,8);assert.equal(mp4Boxes(wide)[0]?.end,16);
  wide.writeBigUInt64BE(9007199254740992n,8);assert.throws(()=>mp4Boxes(wide),isCode("fixture_video"));
});
test("fixed-version HLS parsing confines references and requires a bounded ordered VOD",()=>{
  const id=randomUUID(),master='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=320x180,CODECS="avc1.420015,mp4a.40.2"\n'+id+'/2/playlist.m3u8\n',
    media='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nseg_0.m4s\n#EXTINF:1.936867,\nseg_1.m4s\n#EXT-X-ENDLIST\n';
  assert.equal(parseVideoMaster(master)[0]?.sessionId,id);assert.equal(parseVideoMaster(master)[0]?.variantIndex,2);
  assert.equal(parseVideoPlaylist(media).segments.length,2);assert.equal(parseVideoPlaylist(media).duration,3.936867);
  for(const replacement of ["https://external.invalid/2/playlist.m3u8","//host/2/playlist.m3u8","../2/playlist.m3u8",id+"/2/playlist.m3u8?key=secret",id+"/2/%2e%2e/playlist.m3u8",id+"/-1/playlist.m3u8"])
    assert.throws(()=>parseVideoMaster(master.replace(id+"/2/playlist.m3u8",replacement)),isCode("fixture_video"));
  for(const broken of [media.replace("seg_1.m4s","seg_2.m4s"),media.replace("2.000000","20.000000"),media.replace('URI="init.mp4"','URI="https://external.invalid/init.mp4"'),media.replace("#EXT-X-ENDLIST\n",""),media.replace("#EXT-X-PLAYLIST-TYPE:VOD","#EXT-X-PLAYLIST-TYPE:EVENT")])
    assert.throws(()=>parseVideoPlaylist(broken),isCode("fixture_video"));
});
test("a real browser decodes unique original MP4 and init-plus-fragments into changing color frames",{timeout:90000},async()=>{
  const video=syntheticVideo(randomUUID(),"a"),browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  try{
    const page=await browser.newPage();await page.route("**/*",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Video fixture decode</title>"}));await page.goto("http://127.0.0.1/video-fixture");
    const sources=[[video.bytes.toString("base64")],[video.init,...video.fragments].map(x=>x.toString("base64"))];
    const result=await page.evaluate(String.raw`(async(sources)=>{
      const results=[];
      for(const source of sources){
        const chunks=source.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))),blob=new Blob(chunks,{type:"video/mp4"}),
          url=URL.createObjectURL(blob),video=document.createElement("video");video.muted=true;document.body.append(video);
        const event=name=>new Promise((accept,reject)=>{
          const timer=setTimeout(()=>reject(Error("Video decode timeout")),10000);
          video.addEventListener(name,()=>{clearTimeout(timer);accept();},{once:true});
          video.addEventListener("error",()=>{clearTimeout(timer);reject(Error("Video decode error"));},{once:true});
        });
        const loaded=event("loadeddata");video.src=url;video.load();await loaded;
        const canvas=document.createElement("canvas");canvas.width=320;canvas.height=180;const ctx=canvas.getContext("2d"),pixels=[];
        for(const time of [0.2,2.5]){const seeked=event("seeked");video.currentTime=time;await seeked;ctx.drawImage(video,0,0);pixels.push([...ctx.getImageData(15,15,1,1).data]);}
        results.push({width:video.videoWidth,height:video.videoHeight,duration:video.duration,pixels});
        video.removeAttribute("src");video.load();video.remove();URL.revokeObjectURL(url);
      }return results;
    })(`+JSON.stringify(sources)+")") as {width:number;height:number;duration:number;pixels:number[][]}[];
    assert.equal(result.length,2);for(const item of result){assert.equal(item.width,320);assert.equal(item.height,180);assert.ok(Math.abs(item.duration-video.durationMs/1000)<0.01);
      assert.ok(item.pixels[0]![0]!>item.pixels[0]![2]!+100);assert.ok(item.pixels[1]![2]!>item.pixels[1]![0]!+100);}
  }finally{await browser.close();}
});
test("native HTTP video fixtures verify bytes, ranges, HLS headers and end ack, then repeat only non-mutating reads",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-native-video-")),root=join(base,"run"),{backend,model,http}=videoBackend(),errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("test request bound");chunks.push(chunk);}
      const body=Buffer.concat(chunks),response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers:req.headers as any,...(body.length?{body:body as any}:{}),redirect:"manual"});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error);res.writeHead(500,{"content-type":"application/json"});res.end('{"message":"synthetic video harness failed"}');}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root);
    await upLab(root,{docker:runner});await seedHarnessAccounts(root,backend);
    const first=await createVideoFixtures(root,{docker:runner});assert.equal(first.state,"video_fixtures_ready");assert.equal(first.execution_scope,"harness_only");
    assert.equal(first.hls_end_acknowledged,true);assert.equal(first.hls_worker_cleanup_verified,false);assert.deepEqual(model.config,model.initialConfig);
    assert.equal(model.assets.length,2);assert.equal(model.masterCalls,1);assert.equal(model.segmentCalls,3);assert.equal(model.sessions.size,0);
    const report=JSON.parse(await readFile(first.report,"utf8")),cases=report.operations.flatMap((op:any)=>op.cases);
    assert.equal(cases.length,40);assert.ok(cases.every((c:any)=>c.state==="passed"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    for(const op of report.operations){assert.equal(op.real_success_cases,0);assert.equal(op.integration_success,"not_run");}
    for(const name of ["getMainPlaylist","getMediaPlaylist","getSegment","endSession"]){
      const hls=report.operations.find((op:any)=>op.operation_id===name).cases;assert.ok(hls.length);assert.ok(hls.every((c:any)=>c.mutates===true));
    }
    const saved=await journal(root),configCases=saved.cases.filter((c:any)=>c.operation_id==="updateAdminConfig");
    for(const c of configCases){assert.equal(c.input.body.oauth.clientSecret,undefined);assert.equal(c.input.body.notifications.smtp.transport.password,undefined);assert.equal(c.input.secret_bindings.length,2);}
    const publicText=JSON.stringify(report);for(const value of [model.initialConfig.oauth.clientSecret,model.initialConfig.notifications.smtp.transport.password,...backend.keys.map(k=>k.secret)])assert.ok(!publicText.includes(value));
    assert.ok(!publicText.includes(saved.data.hls.session_id));assert.ok(!publicText.includes("result_ref"));assert.ok(!publicText.includes("secret_ref"));
    const scan=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else{const data=await readFile(path);for(const value of [model.initialConfig.oauth.clientSecret,model.initialConfig.notifications.smtp.transport.password,...backend.keys.map(k=>k.secret)])assert.equal(data.includes(Buffer.from(value)),false);}}};
    await scan(root);
    backend.calls.length=0;const second=await createVideoFixtures(root,{docker:runner});assert.equal(second.state,"video_fixtures_revalidated");
    assert.ok(backend.calls.every(c=>c.method==="GET"&&!c.path.includes("/video/stream/")));assert.equal(model.masterCalls,1);assert.deepEqual(model.config,model.initialConfig);
    const validated=await journal(root);assert.equal(validated.validation.cases.length,20);
    model.corruptRange=true;backend.calls.length=0;await assert.rejects(createVideoFixtures(root,{docker:runner}),isCode("fixture_validation_failed"));
    assert.ok(backend.calls.every(c=>c.method==="GET"&&!c.path.includes("/video/stream/")));assert.equal((await journal(root)).state,"completed");
    assert.equal(errors.length,0,errors.map(String).join("\n"));
  }catch(error){try{const saved=await journal(root);const c=saved.cases.at(-1);t.diagnostic("last_video_case="+JSON.stringify({id:c?.id,status:c?.status,state:c?.state,diagnostic_code:c?.diagnostic_code}));}catch{}t.diagnostic("native_video_errors="+JSON.stringify(errors.map(e=>({name:(e as any)?.name,code:(e as any)?.code}))));throw error;}
  finally{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));await rm(base,{recursive:true,force:true});}
});
test("a lost HLS main acknowledgement fences its GET side effect, uploads and configuration on restart",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostMaster=true;await assert.rejects(createVideoFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const first=await journal(root);assert.equal(first.state,"recovery_required");assert.equal(first.cases.at(-1).id,"hls_main");
    assert.equal(first.cases.at(-1).mutates,true);assert.equal(first.cases.at(-1).state,"outcome_unknown");assert.equal(model.sessions.size,1);assert.equal(model.masterCalls,1);
    const count=backend.calls.length;model.lostMaster=false;await assert.rejects(createVideoFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.masterCalls,1);assert.equal(model.assets.length,2);assert.equal(model.config.ffmpeg.realtime.enabled,true);
    assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
    assert.deepEqual(first.data.original_config,model.initialConfig);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("malformed HLS references, corrupt fragments and an ineffective restore fail semantic acceptance",async t=>{
  for(const fault of ["badMaster","badFragment","restoreNoEffect"] as const)await t.test(fault,async()=>{
    const {base,root,runner,backend,model,http}=await environment();
    try{
      model[fault]=true;await assert.rejects(createVideoFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      const saved=await journal(root);assert.equal(saved.state,"recovery_required");const failed=saved.cases.find((c:any)=>c.state==="failed");assert.equal(failed?.id,fault==="badMaster"?"hls_main":fault==="badFragment"?"hls_segment_0":"restore_admin_config");
      assert.ok(backend.calls.every(c=>!c.path.includes("elsewhere.invalid")));
      const count=backend.calls.length;await assert.rejects(createVideoFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
      assert.ok(backend.calls.slice(count).every(c=>c.path==="/api/server/version"||c.path==="/api/api-keys/me"));
      if(fault==="badMaster")assert.equal(model.segmentCalls,0);
      if(fault==="restoreNoEffect")assert.equal(model.config.ffmpeg.realtime.enabled,true);
    }finally{await rm(base,{recursive:true,force:true});}
  });
});
test("nested fixture secret bindings preserve empty strings and enforce declared targets, ownership and revision",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async context=>{
      const run=new IntegrationRun(context,"nested_video_secrets_v1"),body=structuredClone(model.config);delete body.oauth.clientSecret;delete body.notifications.smtp.transport.password;
      const call=run.protect("admin",{operation_id:"updateAdminConfig",body},{"/oauth/clientSecret":"","/notifications/smtp/transport/password":"nested-canary"});
      await run.execute({id:"protected_config",actor:"admin",call,status:200,kind:"success",mutates:true,assertions:["protected_values"]},(_result,check)=>{
        check(model.config.oauth.clientSecret===""&&model.config.notifications.smtp.transport.password==="nested-canary","protected_values");
      });
      assert.equal(call.body.oauth.clientSecret,undefined);assert.equal(call.secret_bindings?.length,2);
      assert.throws(()=>run.protect("admin",{operation_id:"updateAdminConfig",body:{}},{"/ffmpeg/preset":"not-a-secret"}),isCode("fixture_secret"));
      assert.throws(()=>run.protect("admin",{operation_id:"updateAdminConfig",body:{}},{"/oauth/clientSecret":"missing-parent"}),isCode("fixture_secret"));
      assert.throws(()=>run.protect("admin",{operation_id:"updateAdminConfig",body:{oauth:{clientSecret:"inline"}}},{"/oauth/clientSecret":"duplicate"}),isCode("fixture_secret"));
      const count=backend.calls.length;
      await run.execute({id:"other_secret",actor:"a",call,status:null,kind:"local_refusal",expected_error:"invalid_reference",mutates:true,assertions:["binding_isolation"]},(_result,check)=>check(backend.calls.length===count,"binding_isolation"));
      const p=context.actors.admin.principal,credential=context.vault.credential(p);context.vault.replaceBinding(p,credential.key,credential.keyId,credential.revision);
      await run.execute({id:"stale_secret",actor:"admin",call,status:null,kind:"local_refusal",expected_error:"invalid_reference",mutates:true,assertions:["revision_isolation"]},(_result,check)=>check(backend.calls.length===count,"revision_isolation"));
      run.finish();
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});

});
