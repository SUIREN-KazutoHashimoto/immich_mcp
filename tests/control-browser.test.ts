import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccessAuth } from "../src/access.js";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Control } from "../src/control.js";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";

test("native browser key forms preserve same-origin Origin and still enforce CSRF",{timeout:90000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"immich-control-browser-")),key=randomBytes(32);
  const vault=new Vault(directory,key,"test",":memory:");
  const config={issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.test"};
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="test";
  const access=new AccessAuth(config,createLocalJWKSet({keys:[jwk]}));
  const assertion=await new SignJWT({sub:"A",iss:config.issuer,aud:config.audience,exp:Math.floor(Date.now()/1000)+300}).setProtectedHeader({alg:"RS256",kid:"test"}).sign(privateKey);
  const principal=await access.authenticate(assertion),canary="SYNTHETIC-BROWSER-KEY";
  let registrations=0;
  const executor=new Executor("http://immich.test/api",vault,(async(url:any,init:any)=>{
    assert.equal(new URL(String(url)).pathname,"/api/api-keys/me");
    assert.equal(init.headers.get("x-api-key"),canary);registrations++;
    return Response.json(sample(registry.schemas.ApiKeyResponseDto!));
  }) as typeof fetch);
  const control=new Control(access,vault,executor,key);
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  const context=await browser.newContext(),page=await context.newPage(),origins:string[]=[];
  try{
    await context.route("**/*",async route=>{
      const request=route.request();
      if(new URL(request.url()).origin!==config.publicOrigin){await route.abort();return;}
      const headers:Record<string,string>={...await request.allHeaders(),"cf-access-jwt-assertion":assertion};
      if(request.method()==="POST")origins.push(headers.origin ?? "missing");
      const body=request.postDataBuffer();
      const response=await control.fetch(new Request(request.url(),{method:request.method(),headers,...(body?{body:new Uint8Array(body)}:{})}));
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(config.publicOrigin+"/connect");
    await page.getByLabel("Your Immich API key").fill(canary);
    const savedResponse=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/connect/key");
    await page.getByRole("button",{name:"Validate and save key",exact:true}).click();
    assert.equal((await savedResponse).status(),303,"Native form Origin: "+origins[0]);
    // Playwright only routes the initial URL in a redirect chain. Open the
    // destination explicitly to inspect the persisted binding in this fixture.
    await page.goto(config.publicOrigin+"/connect");
    await page.getByText("Status: active",{exact:true}).waitFor();
    assert.deepEqual(origins,[config.publicOrigin]);assert.equal(registrations,1);
    assert.equal(vault.credential(principal).key,canary);
    assert.equal(await page.getByLabel("Your Immich API key").inputValue(),"");
    assert.ok(!(await page.content()).includes(canary));
    assert.ok(!(await page.evaluate(()=>document.cookie)).includes("__Host-immich-csrf"));
    await page.getByLabel("Your Immich API key").fill(canary);
    await page.evaluate(()=>{document.querySelector<HTMLInputElement>('form[action="/connect/key"] input[name="csrf"]')!.value="invalid";});
    const deniedResponse=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/connect/key");
    await page.getByRole("button",{name:"Validate and save key",exact:true}).click();
    const denied=await deniedResponse;assert.equal(denied.status(),403);assert.match(await denied.text(),/csrf/);
    assert.deepEqual(origins,[config.publicOrigin,config.publicOrigin]);assert.equal(registrations,1);
  }finally{await context.close();await browser.close();await executor.close();vault.close();await rm(directory,{recursive:true,force:true});}
});
