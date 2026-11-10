import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareLab,upLab } from "../src/integration-lab.js";
import { bootstrapLab,withInitializedFixtureLab,fixtureServerId } from "../src/integration-bootstrap.js";
import { createFeatureFixtures,MEDIA_PLAN } from "../src/integration-fixtures.js";
import { IntegrationRun,type CaseSpec } from "../src/integration-run.js";
import { syntheticPhoto } from "../src/integration-media.js";
import { BridgeError } from "../src/types.js";
import { Vault } from "../src/vault.js";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { mediaBackend,seedHarnessAccounts } from "./media-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const mutating=(calls:{method:string}[])=>calls.filter(c=>!["GET","HEAD"].includes(c.method)).length;
async function environment(){
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{backend,model,http}=mediaBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);return {base,root,fake,runner,backend,model,http};
}
async function journal(root:string){
  const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
  try{return vault.get("__integration_feature_runs",MEDIA_PLAN,"fixture_run");}finally{vault.close();}
}
test("the complete bootstrap/media pipeline uses native HTTP, multipart decoding and original bytes while retaining private/limited access",async t=>{
  const base=await mkdtemp(join(tmpdir(),"immich-native-fixtures-")),root=join(base,"run"),{backend,model,http}=mediaBackend(),serverErrors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.connection,"close");
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error("test request bound");chunks.push(chunk);}
      const body=Buffer.concat(chunks),response=await http("http://127.0.0.1:22835"+req.url,{method:req.method,headers:req.headers as any,...(body.length?{body:body as any}:{}),redirect:"manual"});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){serverErrors.push(error);res.writeHead(500,{"content-type":"application/json"});res.end('{"message":"synthetic HTTP harness failed"}');}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const port=(server.address() as any).port;await prepareLab(root,port);const {runner}=fakeDocker(root);
    await upLab(root,{docker:runner});await bootstrapLab(root,{docker:runner});
    const result=await createFeatureFixtures(root,{docker:runner});assert.equal(result.state,"fixtures_ready");assert.equal(result.execution_scope,"harness_only");
    assert.equal(model.assets.length,3);assert.equal(model.albums.length,2);assert.equal(model.tags.length,1);
    const firstUpload=backend.calls.find(c=>c.path==="/api/assets"&&c.method==="POST")!;assert.equal(firstUpload.body.fields.filename,undefined);
    const a=model.assets.filter(x=>!x.owner.isAdmin&&x.owner===backend.keys[1]!.owner);assert.equal(a.length,2);assert.ok(a.some(x=>x.sidecar?.length));
    const report=JSON.parse(await readFile(result.report,"utf8"));assert.equal(report.operations.length,279);assert.equal(report.categories.length,41);
    assert.equal(report.fixture_state,"completed");assert.equal(report.operations.reduce((n:number,op:any)=>n+op.cases.length,0),42);assert.equal(report.full_acceptance,false);assert.equal(report.api_integration_completed,false);
    assert.ok(report.operations.every((op:any)=>op.integration_success==="not_run"&&op.real_success_cases===0));
    assert.equal(report.categories.filter((c:any)=>c.harness_success_cases>0).length,6);
    const upload=report.operations.find((op:any)=>op.operation_id==="uploadAsset");assert.equal(upload.cases.length,4);assert.ok(upload.cases.some((c:any)=>c.id==="deliberate_duplicate"&&c.status===200));
    const denied=report.operations.find((op:any)=>op.operation_id==="getAssetInfo").cases.filter((c:any)=>c.kind==="refusal");assert.ok(denied.length>=2);assert.ok(denied.every((c:any)=>c.state==="passed"&&c.status===400));
    const text=JSON.stringify(report);for(const key of backend.keys)assert.ok(!text.includes(key.secret));for(const user of backend.users)assert.ok(!text.includes(user.password));
    assert.ok(!text.includes("file_ref"));assert.ok(!text.includes("result_ref"));assert.ok(!text.includes("secret_ref"));assert.ok(!text.includes("example.invalid"));
    backend.calls.length=0;const validated=await createFeatureFixtures(root,{docker:runner});assert.equal(validated.state,"fixtures_revalidated");assert.equal(mutating(backend.calls),0);
    model.corruptDownload=true;backend.calls.length=0;
    await assert.rejects(createFeatureFixtures(root,{docker:runner}),isCode("fixture_validation_failed"));assert.equal(mutating(backend.calls),0);
    const failed=JSON.parse(await readFile(result.report,"utf8"));assert.equal(failed.fixture_state,"completed");assert.equal(failed.latest_validation.state,"failed");
    assert.ok(failed.latest_validation.cases.some((c:any)=>c.id==="owner_original_a"&&c.state==="failed"&&c.status===200));
    assert.equal(serverErrors.length,0,serverErrors.map(String).join("\n"));
  }catch(error){
    t.diagnostic("synthetic_server_errors="+JSON.stringify(serverErrors.map(e=>({name:(e as any)?.name,code:(e as any)?.code}))));
    throw error;
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(base,{recursive:true,force:true});}
});
test("a lost upload acknowledgement leaves a persistent outcome-unknown receipt and never reuploads on restart",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.lostUpload=true;await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    assert.equal(model.assets.length,1);const saved=await journal(root);assert.equal(saved.state,"recovery_required");assert.equal(saved.cases.at(-1).state,"outcome_unknown");
    const count=mutating(backend.calls);model.lostUpload=false;
    await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(mutating(backend.calls),count);assert.equal(model.assets.length,1);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("HTTP 200 with a per-item album failure fails its semantic assertion instead of becoming integration success",async()=>{
  const {base,root,runner,backend,model,http}=await environment();
  try{
    model.partialBulk=true;await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),failed=saved.cases.find((c:any)=>c.id==="add_album_asset_private");
    assert.equal(failed.status,200);assert.equal(failed.state,"failed");assert.equal(failed.diagnostic_code,"fixture_assertion");assert.equal(model.albums[0].assets.size,0);
    const count=mutating(backend.calls);await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(mutating(backend.calls),count);
    const report=JSON.parse(await readFile(join(root,MEDIA_PLAN+".report.json"),"utf8"));assert.equal(report.full_acceptance,false);assert.equal(report.fixture_state,"recovery_required");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("sharing a schema-valid album response without adding the viewer is detected before publishing ready fixtures",async()=>{
  const {base,root,runner,model,http}=await environment();
  try{
    model.shareNoEffect=true;await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));
    const saved=await journal(root),failed=saved.cases.find((c:any)=>c.id==="share_album_viewer");assert.equal(failed.status,200);assert.equal(failed.state,"failed");
    assert.equal(model.albums[1].viewers.length,0);assert.equal(model.tags.length,0);assert.equal(saved.state,"recovery_required");
  }finally{await rm(base,{recursive:true,force:true});}
});
test("the scenario journal requires actual assertions and refuses new or disguised mutations during read-only revalidation",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async ctx=>{
      const spec:CaseSpec={id:"version",actor:"admin",call:{operation_id:"getServerVersion"},status:200,kind:"success",mutates:false,assertions:["version"]};
      const incomplete=new IntegrationRun(ctx,"empty_assertions_v1");
      await assert.rejects(incomplete.execute(spec,()=>{}),isCode("fixture_assertion"));assert.throws(()=>incomplete.finish(),isCode("fixture_assertion"));
      const run=new IntegrationRun(ctx,"journal_guards_v1");
      await run.execute(spec,(result,check)=>check(result.data.patch===5,"version"));run.finish();
      const again=new IntegrationRun(ctx,"journal_guards_v1"),count=mutating(backend.calls),all=backend.calls.length;
      await assert.rejects(again.execute({...spec,mutates:true},()=>{}),isCode("fixture_replay"));
      await assert.rejects(again.execute({...spec,call:{operation_id:"createAlbum",body:{albumName:"must-not-exist"}},status:201,mutates:false},()=>{}),isCode("fixture_replay"));
      assert.equal(backend.calls.length,all);assert.equal(mutating(backend.calls),count);
      await again.execute(spec,(result,check)=>check(result.data.patch===5,"version"));again.finish();
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});
test("synthetic PNGs decode in a real browser, remain deterministic, and include valid non-secret XMP", {timeout:90000},async()=>{
  const id=randomUUID(),a=syntheticPhoto(id,"a"),privateA=syntheticPhoto(id,"private_a"),b=syntheticPhoto(id,"b");
  assert.deepEqual(a.bytes,syntheticPhoto(id,"a").bytes);assert.equal(new Set([a.sha256,privateA.sha256,b.sha256]).size,3);
  assert.throws(()=>syntheticPhoto("not-a-run","a"));assert.ok(a.filename.includes("\u8a66\u9a13"));
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  try{
    const page=await browser.newPage();await page.setContent('<img id="fixture" src="data:image/png;base64,'+a.bytes.toString("base64")+'">');
    const dimensions=await page.locator("#fixture").evaluate(async(img:any)=>{await img.decode();return [img.naturalWidth,img.naturalHeight];});
    assert.deepEqual(dimensions,[64,32]);
    const valid=await page.evaluate(text=>new DOMParser().parseFromString(text,"application/xml").querySelector("parsererror")===null,a.sidecar.toString("utf8"));assert.equal(valid,true);
  }finally{await browser.close();}
});
test("actual process death after an upload's sent receipt preserves the mutation fence across SQLite reopen",async()=>{
  const {base,root,runner,backend,http}=await environment();
  const uri=(file:string)=>pathToFileURL(join(process.cwd(),"dist",file)).href;
  const source='import {createFeatureFixtures} from '+JSON.stringify(uri("src/integration-fixtures.js"))+';import {upLab} from '+JSON.stringify(uri("src/integration-lab.js"))+
    ';import {fakeDocker} from '+JSON.stringify(uri("tests/lab-harness.js"))+';import {mediaBackend,loadHarnessAccounts} from '+JSON.stringify(uri("tests/media-harness.js"))+';'+
    'const root='+JSON.stringify(root)+';const {runner}=fakeDocker(root);const {backend,http}=mediaBackend();await loadHarnessAccounts(root,backend);await upLab(root,{docker:runner,http});'+
    'backend.before=async path=>{if(path==="/api/assets"){setInterval(()=>{},1000);process.stdout.write("media-paused\\n");await new Promise(()=>{});}};await createFeatureFixtures(root,{docker:runner,http});';
  const worker=spawn(process.execPath,["--input-type=module","--eval",source],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="",errors="";worker.stdout!.on("data",x=>{output+=x.toString();});worker.stderr!.on("data",x=>{errors+=x.toString();});
  const closed=new Promise<void>((accept,reject)=>{worker.once("error",reject);worker.once("close",()=>accept());});
  try{
    await new Promise<void>((accept,reject)=>{
      const timer=setTimeout(()=>reject(Error("media child did not pause: "+errors)),45000);
      const check=()=>{if(output.includes("media-paused\n")){clearTimeout(timer);accept();}};worker.stdout!.on("data",check);
      worker.once("close",()=>{clearTimeout(timer);if(!output.includes("media-paused\n"))reject(Error("media child exited: "+errors));});check();
    });
    worker.kill("SIGKILL");await closed;const saved=await journal(root);assert.equal(saved.state,"started");assert.equal(saved.cases.at(-1).state,"sent");
    const count=mutating(backend.calls);await assert.rejects(createFeatureFixtures(root,{docker:runner,http}),isCode("fixture_recovery_required"));assert.equal(mutating(backend.calls),count);
  }finally{worker.kill("SIGKILL");await closed.catch(()=>{});await rm(base,{recursive:true,force:true});}
});

test("native version observation rejects a redirect without following its target",async()=>{
  const base=await mkdtemp(join(tmpdir(),"immich-version-redirect-")),root=join(base,"run");let version=0,followed=0;
  const server=createServer((req,res)=>{
    if(req.url==="/api/server/version"){version++;res.writeHead(302,{location:"/should-not-follow"});res.end();}
    else{followed++;res.writeHead(200,{"content-type":"application/json"});res.end('{"major":3,"minor":3,"patch":5,"prerelease":null}');}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    await prepareLab(root,(server.address() as any).port);const {runner}=fakeDocker(root);
    await assert.rejects(upLab(root,{docker:runner}),isCode("lab_version"));assert.equal(version,1);assert.equal(followed,0);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(base,{recursive:true,force:true});}
});
