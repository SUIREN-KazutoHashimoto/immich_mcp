import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomBytes} from "node:crypto";
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {chromium} from "playwright";
import {Application} from "../src/app.js";
import {referenceReceipt,controlPage} from "../src/control-ui.js";

test("Japanese settings remain usable on desktop/mobile and never expose stored credentials", {timeout:90000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-settings-ui-")),issuer="https://team.cloudflareaccess.com",origin="https://mcp.example.test";
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="settings-ui";
  const token=await new SignJWT({iss:issuer,aud:"ui",sub:"synthetic-ui-user",exp:Math.floor(Date.now()/1000)+240})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
  const app=await Application.create({directory:dir,masterKey:randomBytes(32),upstream:"http://immich/api",publicOrigin:origin,issuer,audience:"ui",
    jwksUrl:issuer+"/cdn-cgi/access/certs",host:"127.0.0.1",port:0},{databasePath:":memory:",versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0,
      jwks:createLocalJWKSet({keys:[jwk]}),http:async()=>Response.json({major:3,minor:4,patch:1,prerelease:null,featureLevel:2})});
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:"reduce"}),page=await context.newPage();
  const requests:string[]=[];const screenshots=process.env.MCP_UI_SCREENSHOT_DIR;
  const capture=async(name:string)=>{if(screenshots){await mkdir(resolve(screenshots),{recursive:true});await page.screenshot({path:join(resolve(screenshots),name+".png"),fullPage:true});}};
  try{
    await context.route("**/*",async route=>{
      const req=route.request(),url=new URL(req.url());requests.push(url.origin);assert.equal(url.origin,origin);
      const response=await app.fetch(new Request(req.url(),{method:req.method(),headers:{...await req.allHeaders(),"cf-access-jwt-assertion":token},
        ...(req.postDataBuffer()?{body:new Uint8Array(req.postDataBuffer()!)}:{})}));
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(origin+"/connect");assert.equal(await page.locator("html").getAttribute("lang"),"ja");
    assert.equal(await page.getByLabel("APIキー",{exact:true}).getAttribute("type"),"password");
    await page.getByText("未登録",{exact:true}).waitFor();await capture("settings-desktop");
    const principal=await app.access.authenticate(token),canary="PRIVATE-STORED-KEY-CANARY";
    app.vault.replaceBinding(principal,canary,"11111111-1111-4111-8111-111111111111",0);
    await page.reload();await page.getByText("登録済み",{exact:true}).waitFor();
    assert.ok(!(await page.content()).includes(canary));assert.equal(await page.getByLabel("APIキー",{exact:true}).inputValue(),"");
    await capture("settings-connected");
    const details=page.locator("details.panel");
    assert.equal(await details.count(),4);assert.equal(await page.locator("details.panel[open]").count(),0);
    await details.first().locator("summary").first().focus();await page.keyboard.press("Enter");
    assert.equal(await details.first().getAttribute("open"),"");
    assert.equal(await page.locator('input[name="acknowledge"]').first().isChecked(),false);
    assert.equal(await page.locator('input[name="credential"]').getAttribute("type"),"password");
    assert.equal(await page.locator('select[name="ttl_seconds"]').inputValue(),"3600");
    for(const width of [390,360]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"No horizontal overflow at "+width);
      const box=await page.getByRole("button",{name:"確認して保存",exact:true}).boundingBox();assert.ok(box&&box.height>=44&&box.width>=100);
    }
    await details.first().locator("summary").first().click();await capture("settings-mobile");
    await page.locator("details.panel").nth(1).locator("summary").first().click();
    assert.equal(await page.locator('input[name="value"]').getAttribute("type"),"password");
    assert.equal(await page.locator('input[name="value"]').getAttribute("required"),null,"Empty secrets remain allowed for supported APIs");
    await page.setViewportSize({width:1280,height:900});
    const receipt=controlPage(referenceReceipt("秘密情報の参照IDを発行しました","指定した操作と入力先で利用できます。","secret_11111111-1111-4111-8111-111111111111"));
    await page.setContent(await receipt.text());await capture("settings-receipt");
    assert.equal(await page.locator("code").textContent(),"secret_11111111-1111-4111-8111-111111111111");
    assert.ok(requests.every(url=>url===origin));
  }finally{await context.close();await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
