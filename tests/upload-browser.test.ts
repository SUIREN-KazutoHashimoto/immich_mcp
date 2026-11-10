import test from "node:test";
import assert from "node:assert/strict";
import { chromium,type Browser,type Page } from "playwright";
import { createHash,randomBytes } from "node:crypto";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Staging } from "../src/staging.js";
import { Uploads } from "../src/uploads.js";
import { DownloadPolicy } from "../src/download.js";
import { Executor } from "../src/executor.js";
import { AccessAuth } from "../src/access.js";
import { Control } from "../src/control.js";

const bytes=Buffer.from([0,255,10,128,30,40,1,2]);
async function fixture(browser:Browser,drop:"chunk"|"complete",run:(page:Page,v:Vault,s:Staging,principal:string,counts:{start:number;chunk:number;complete:number;ref:string;filePath:string})=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"immich-browser-")),key=randomBytes(32);
  const v=new Vault(directory,key,"test",":memory:");
  const config={issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"};
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="test";
  const access=new AccessAuth(config,createLocalJWKSet({keys:[jwk]}));
  const assertion=await new SignJWT({sub:"A",iss:config.issuer,aud:config.audience,exp:Math.floor(Date.now()/1000)+300}).setProtectedHeader({alg:"RS256",kid:"test"}).sign(privateKey);
  const principal=await access.authenticate(assertion);
  v.replaceBinding(principal,"SYNTHETIC-KEY","test-id",0);
  const s=new Staging(v,new DownloadPolicy([]),{maxFileBytes:100,quotaBytes:200}),uploads=new Uploads(s,3);
  const e=new Executor("http://immich/api",v,(async()=>{throw Error("Browser staging must not invoke Immich");}) as typeof fetch);
  const control=new Control(access,v,e,key,s,undefined,uploads);
  const context=await browser.newContext(),page=await context.newPage();
  const filePath=join(directory,"photo.bin");await writeFile(filePath,bytes);
  const counts={start:0,chunk:0,complete:0,ref:"",filePath};let dropped=false;
  try{
    await context.route("**/*",async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.origin!==config.publicOrigin){await route.abort();return;}
      const body=req.postDataBuffer(),headers={...await req.allHeaders(),"cf-access-jwt-assertion":assertion};
      const response=await control.fetch(new Request(req.url(),{method:req.method(),headers,...(body?{body:new Uint8Array(body)}:{})}));
      const reply=Buffer.from(await response.arrayBuffer());
      if(url.pathname==="/connect/upload/start"&&response.ok){counts.start++;counts.ref=JSON.parse(reply.toString()).upload_ref;}
      if(url.pathname==="/connect/upload/chunk")counts.chunk++;
      if(url.pathname==="/connect/upload/complete")counts.complete++;
      if(!dropped && url.pathname==="/connect/upload/"+drop && response.ok){
        dropped=true;await route.abort("connectionreset");return;
      }
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:reply});
    });
    await page.goto(config.publicOrigin+"/connect");
    assert.ok(!(await page.evaluate(()=>document.cookie)).includes("__Host-immich-csrf"));
    await page.locator("#upload-file").setInputFiles(filePath);
    await run(page,v,s,principal,counts);
  }finally{await context.close();v.close();await rm(directory,{recursive:true,force:true});}
}
const clickAndWaitForFailure=async(page:Page)=>{
  await page.locator("#upload-button").click();
  await page.waitForFunction(()=>document.getElementById("upload-status")!.textContent!.includes("retry to resume"));
};
const waitForFile=async(page:Page)=>{
  await page.waitForFunction(()=>document.getElementById("upload-status")!.textContent!.includes('"file_ref"'));
  return JSON.parse((await page.locator("#upload-status").textContent())!);
};
test("real browser resumes interrupted transfers and verifies reselected file content",{timeout:180000},async t=>{
  const launchedAt=Date.now();
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  t.diagnostic("Browser launch completed in "+(Date.now()-launchedAt)+"ms");
  try{
    await t.test("lost chunk acknowledgement resumes without duplicate writes and preserves bytes",{timeout:45000},async()=>fixture(browser,"chunk",async(page,v,s,p,counts)=>{
      const denied=await page.evaluate(async()=>{
        const r=await fetch("/connect/upload/start",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":"wrong"},body:JSON.stringify({filename:"a",mime:"application/octet-stream",size:1})});
        return r.status;
      });
      assert.equal(denied,403);assert.equal(counts.start,0);
      await clickAndWaitForFailure(page);await page.reload();await page.locator("#upload-file").setInputFiles(counts.filePath);await page.locator("#upload-button").click();
      const file=await waitForFile(page);
      assert.equal(counts.start,1);assert.equal(counts.chunk,3);
      assert.equal(file.sha256,createHash("sha256").update(bytes).digest("hex"));
      const part=await s.file(p,file.file_ref);
      assert.deepEqual(Buffer.from(await new Response(part.open() as any).arrayBuffer()),bytes);
      assert.equal(await page.evaluate(()=>localStorage.length),0);
    }));
    await t.test("lost completion acknowledgement returns the same staged file",{timeout:45000},async()=>fixture(browser,"complete",async(page,v,s,p,counts)=>{
      await clickAndWaitForFailure(page);
      const before=(v.db.prepare("SELECT id FROM records WHERE principal=? AND kind='staged_file'").get(p) as any).id;
      await page.locator("#upload-button").click();
      const file=await waitForFile(page);assert.equal(file.file_ref,before);
      assert.equal(counts.start,1);assert.equal(counts.complete,1);
    }));
    await t.test("same metadata with different selected bytes cannot resume the old upload",{timeout:45000},async()=>fixture(browser,"chunk",async(page,v,s,p,counts)=>{
      await clickAndWaitForFailure(page);
      await page.evaluate(()=>{
        const input=document.getElementById("upload-file") as HTMLInputElement,old=input.files![0]!,data=new DataTransfer();
        data.items.add(new File([Uint8Array.of(1,255,10,128,30,40,1,2)],old.name,{type:old.type,lastModified:old.lastModified}));
        input.files=data.files;
      });
      await page.locator("#upload-button").click();
      await page.waitForFunction(()=>document.getElementById("upload-status")!.textContent!.includes("Selected file differs"));
      assert.equal(counts.start,1);assert.equal(counts.chunk,1);
      assert.equal((v.db.prepare("SELECT COUNT(*) n FROM records WHERE kind='staged_file'").get() as any).n,0);
    }));
    await t.test("a different file requires explicit discard before replacing an interrupted upload",{timeout:45000},async()=>fixture(browser,"chunk",async(page,v,s,p,counts)=>{
      await clickAndWaitForFailure(page);
      await page.locator("#upload-file").setInputFiles({name:"different.bin",mimeType:"application/octet-stream",buffer:bytes});
      await page.locator("#upload-button").click();
      await page.waitForFunction(()=>document.getElementById("upload-status")!.textContent!.includes("An interrupted upload exists"));
      assert.equal(counts.start,1);
      await page.locator("#upload-discard").click();
      await page.waitForFunction(()=>document.getElementById("upload-status")!.textContent==="Interrupted upload discarded");
      assert.equal((v.db.prepare("SELECT COUNT(*) n FROM staging_usage").get() as any).n,0);
      await page.locator("#upload-button").click();await waitForFile(page);assert.equal(counts.start,2);
    }));
  }finally{const closingAt=Date.now();await browser.close();t.diagnostic("Browser close completed in "+(Date.now()-closingAt)+"ms");}
});
