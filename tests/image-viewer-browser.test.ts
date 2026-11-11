import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";
import { imageViewerResource } from "../src/image-viewer.js";

async function host(result:any,rejectContext=false,options:{imagePolicy?:string;sandbox?:boolean;disableBlob?:boolean;legacyOnly?:boolean}={}){
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  const context=await browser.newContext({viewport:options.sandbox?{width:390,height:760}:{width:1000,height:760}});
  const page=await context.newPage(),requests:string[]=[];
  const html='<!doctype html><html><body style="margin:16px"><iframe title="Immich preview" style="border:0;width:min(100%,680px);height:700px"></iframe><script>window.messages=[];window.addEventListener("message",e=>{if(e.source!==document.querySelector("iframe").contentWindow)return;const m=e.data;window.messages.push(m);if(m.id){e.source.postMessage({jsonrpc:"2.0",id:m.id,...(m.method==="ui/update-model-context"&&window.rejectContext?{error:{code:-32601,message:"unsupported"}}:{result:{}})},"*");}if(m.method==="ui/notifications/initialized"&&!window.legacyOnly){e.source.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:window.fixture},"*");}});</script></body></html>';
  const bridge='<html><body style="margin:0"><iframe title="sandboxed preview" sandbox="allow-scripts" src="/viewer" style="border:0;width:100%;height:680px"></iframe><script>window.addEventListener("message",e=>{const child=document.querySelector("iframe").contentWindow;if(e.source===child)window.parent.postMessage(e.data,"*");else if(e.source===window.parent)child.postMessage(e.data,"*");});</script></body></html>';
  await context.route("**/*",async route=>{
    const url=new URL(route.request().url());requests.push(url.href);
    let viewer=imageViewerResource().text;
    if(options.disableBlob)viewer=viewer.replace('"use strict";','"use strict";URL.createObjectURL=()=>{throw new Error("object URLs unavailable")};');
    await route.fulfill({status:200,contentType:"text/html",headers:url.pathname==="/viewer"&&options.imagePolicy?{"content-security-policy":"img-src "+options.imagePolicy+"; connect-src \'none\'"}:{},body:url.pathname==="/viewer"?viewer:url.pathname==="/bridge"?bridge:html});
  });
  await page.goto("https://image-viewer.test/");
  await page.evaluate(({result,rejectContext,options})=>{
    (window as any).legacyOnly=options.legacyOnly;(window as any).fixture=result;(window as any).rejectContext=rejectContext;
    document.querySelector("iframe")!.src=options.sandbox?"/bridge":"/viewer";
  },{result,rejectContext,options});
  const outer=page.frameLocator("iframe"),frame=options.sandbox?outer.frameLocator("iframe"):outer;
  const send=async(payload:any)=>page.evaluate(p=>document.querySelector("iframe")!.contentWindow!.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:p},"*"),payload);
  return {browser,context,page,frame,send,requests,close:async()=>{await context.close();await browser.close();}};
}
async function fixture(){
  const bytes=await sharp({create:{width:240,height:120,channels:3,background:"#dd2233"}}).jpeg().toBuffer();
  const image={type:"image",data:bytes.toString("base64"),mimeType:"image/jpeg"};
  return {image,result:{content:[image,{type:"text",text:"Preview ready"}],_meta:{image_content:image,image_info:{width:240,height:120,size_bytes:bytes.length,display_status:"unconfirmed",request_id:"img_11111111-1111-4111-8111-111111111111",result_ref:"PRIVATE-REF"}}}};
}

test("image viewer renders pixels and forwards them through the host context on an explicit explanation request",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result);
  try{
    await h.frame.getByRole("img",{name:"Immichの画像プレビュー"}).waitFor({state:"visible"});
    assert.deepEqual(await h.frame.locator("img").evaluate((img:HTMLImageElement)=>[img.naturalWidth,img.naturalHeight]),[240,120]);
    assert.match(await h.frame.getByRole("link",{name:"画像を保存"}).getAttribute("href") ?? "",/^data:image\/jpeg;base64,/);
    await h.page.waitForFunction(()=>(window as any).messages.some((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="image")));
    assert.equal(await h.page.evaluate(()=>(window as any).messages.filter((m:any)=>m.method==="ui/message").length),0,"Preparation must not create a user turn");
    await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).click();
    await h.frame.getByRole("status").filter({hasText:"画像の説明を依頼しました。"}).waitFor();
    const messages=await h.page.evaluate(()=>(window as any).messages);
    assert.equal(messages.filter((m:any)=>m.method==="ui/initialize").length,1);
    const prepared=messages.filter((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="image"));
    assert.equal(prepared.length,1,"The same image is prepared once, not resent on explanation clicks");
    assert.deepEqual(prepared[0].params.content.filter((p:any)=>p.type==="image"),[f.image]);
    assert.equal(JSON.parse(prepared[0].params.content.find((p:any)=>p.type==="text").text).display_status,"displayed");
    const message=messages.find((m:any)=>m.method==="ui/message");
    assert.equal(message.params.role,"user");assert.equal(message.params.content.length,1);
    await h.page.setViewportSize({width:390,height:760});
    assert.ok(await h.frame.locator("body").evaluate(el=>el.scrollWidth<=document.documentElement.clientWidth),"mobile viewer must not overflow");
    if(process.env.MCP_IMAGE_VIEWER_SCREENSHOT)await h.page.screenshot({path:process.env.MCP_IMAGE_VIEWER_SCREENSHOT,fullPage:true});
  }finally{await h.close();}
});

test("three different previews prepare the correct model pixels once per image without refetch or replay",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result);
  try{
    await h.frame.getByRole("img").waitFor({state:"visible"});
    for(let index=0;index<3;index++){
      const data=(await sharp({create:{width:160,height:80,channels:3,background:["red","green","blue"][index]!}}).jpeg().toBuffer()).toString("base64");
      const part={type:"image",mimeType:"image/jpeg",data},id="img_22222222-2222-4222-8222-22222222222"+index;
      const result={content:[part],structuredContent:{request_id:id,display_status:"unconfirmed"}};
      await h.send(result);
      await h.page.waitForFunction(id=>(window as any).messages.some((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="text"&&JSON.parse(p.text).request_id===id)),id);
      const before=await h.page.evaluate(()=>(window as any).messages.length);
      await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).click();
      await h.frame.getByRole("status").filter({hasText:"画像の説明を依頼しました。"}).waitFor();
      const after=await h.page.evaluate(start=>(window as any).messages.slice(start),before);
      assert.equal(after.filter((m:any)=>m.method==="ui/update-model-context").length,0,"An already prepared image is not uploaded again on click");
      assert.equal(after.filter((m:any)=>m.method==="ui/message").length,1);
      const contexts=await h.page.evaluate(id=>(window as any).messages.filter((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="text"&&JSON.parse(p.text).request_id===id)),id);
      assert.deepEqual(contexts[0].params.content.find((p:any)=>p.type==="image"),part);assert.equal(contexts.length,1);
      await h.send(result);
    }
    assert.equal(await h.frame.locator("body").evaluate(()=>performance.getEntriesByName("immich-explain-dispatch").length),3);
  }finally{await h.close();}
});

test("viewer supports private metadata fallback, falls back to image messages, and clears stale or invalid pixels",{timeout:90000},async()=>{
  const f=await fixture(),h=await host({content:[{type:"text",text:"metadata"}],_meta:{image_content:f.image}},true);
  try{
    await h.frame.getByRole("img").waitFor({state:"visible"});
    await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).click();
    await h.frame.getByRole("status").filter({hasText:"画像の説明を依頼しました。"}).waitFor();
    const messages=await h.page.evaluate(()=>(window as any).messages);
    assert.deepEqual(messages.find((m:any)=>m.method==="ui/message").params.content[1],f.image);
    await h.send({content:[{type:"text",text:"metadata only"}],structuredContent:{width:240,height:120}});
    await h.frame.getByRole("status").filter({hasText:"画像本体が届いていません。"}).waitFor();
    assert.equal(await h.frame.locator("img").getAttribute("src"),null);
    assert.equal(await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).isDisabled(),true);
    await h.send({content:[{type:"image",mimeType:"image/svg+xml",data:"PHN2Zz4="}]});
    await h.frame.getByRole("status").filter({hasText:"表示できる画像データではありません。"}).waitFor();
    await h.send(f.result);await h.frame.getByRole("img").waitFor({state:"visible"});
    await h.send({});
    await h.frame.getByRole("status").filter({hasText:"画像本体が届いていません。"}).waitFor();
    assert.equal(await h.frame.locator("img").getAttribute("src"),null);
    await h.send(f.result);await h.frame.getByRole("img").waitFor({state:"visible"});
    await h.page.evaluate(()=>document.querySelector("iframe")!.contentWindow!.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-cancelled",params:{}},"*"));
    await h.frame.getByRole("status").filter({hasText:"画像の取得が中止されました。"}).waitFor();
    assert.equal(await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).isDisabled(),true);
  }finally{await h.close();}
});

test("private images render in an opaque nested mobile frame when the host permits data images but blocks blob URLs",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result,false,{imagePolicy:"data:",sandbox:true});
  try{
    try{await h.frame.getByRole("img").waitFor({state:"visible",timeout:5000});}
    catch(error){if(process.env.MCP_IMAGE_CSP_SCREENSHOT)await h.page.screenshot({path:process.env.MCP_IMAGE_CSP_SCREENSHOT});console.error(JSON.stringify({viewer_status:await h.frame.getByRole("status").textContent()}));throw error;}
    assert.deepEqual(await h.frame.locator("img").evaluate((i:HTMLImageElement)=>[i.naturalWidth,i.naturalHeight]),[240,120]);
    assert.match(await h.frame.locator("img").getAttribute("src")??"",/^data:image\/jpeg;base64,/);
    if(process.env.MCP_IMAGE_CSP_SCREENSHOT)await h.page.screenshot({path:process.env.MCP_IMAGE_CSP_SCREENSHOT});
  }finally{await h.close();}
});

test("a blob-only host falls back once and reports displayed only after the image decodes",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result,false,{imagePolicy:"blob:",sandbox:true});
  try{
    await h.frame.getByRole("img").waitFor({state:"visible"});
    assert.match(await h.frame.locator("img").getAttribute("src")??"",/^blob:/);
    await h.page.waitForFunction(()=>(window as any).messages.some((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="text"&&JSON.parse(p.text).display_status==="displayed")));
    const messages=await h.page.evaluate(()=>(window as any).messages);
    assert.equal(messages.filter((m:any)=>m.method==="ui/message").length,0,"rendering must not send an automatic user follow-up");
    assert.ok(h.requests.every(url=>new URL(url).origin==="https://image-viewer.test"));
  }finally{await h.close();}
});

test("data previews and saving remain available when object URLs are unavailable",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result,false,{imagePolicy:"data:",sandbox:true,disableBlob:true});
  try{
    await h.frame.getByRole("img").waitFor({state:"visible"});
    assert.equal(await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).isEnabled(),true);
    assert.match(await h.frame.getByRole("link",{name:"画像を保存"}).getAttribute("href")??"",/^data:image\/jpeg;base64,/);
    assert.deepEqual(await h.frame.locator("img").evaluate((i:HTMLImageElement)=>[i.naturalWidth,i.naturalHeight]),[240,120]);
    assert.ok(h.requests.every(url=>new URL(url).origin==="https://image-viewer.test"));
  }finally{await h.close();}
});

test("blocked previews report failure without false display success, legacy replay loops or automatic user messages",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result,false,{imagePolicy:"'none'",sandbox:true,legacyOnly:true});
  try{
    await h.frame.locator("body").waitFor();
    const update=async()=>h.frame.locator("body").evaluate((_el,result)=>{
      (window as any).openai={toolResponseMetadata:result};window.dispatchEvent(new Event("openai:set_globals"));
    },f.result);
    await update();
    await h.frame.getByRole("status").filter({hasText:"画像を読み込めませんでした。"}).waitFor();
    await h.page.waitForFunction(()=>(window as any).messages.some((m:any)=>m.method==="ui/update-model-context"&&m.params.content.some((p:any)=>p.type==="text"&&JSON.parse(p.text).display_status==="failed")));
    assert.equal(await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).isDisabled(),true);
    assert.equal(await h.frame.locator("img").getAttribute("src"),null);
    const before=await h.page.evaluate(()=>(window as any).messages.filter((m:any)=>m.method==="ui/update-model-context").length);
    await update();await update();
    await h.page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const messages=await h.page.evaluate(()=>(window as any).messages);
    const contexts=messages.filter((m:any)=>m.method==="ui/update-model-context");
    assert.equal(contexts.length,before,"unchanged legacy globals must not restart rendering or publish repeated status");
    assert.ok(contexts.every((m:any)=>JSON.parse(m.params.content[0].text).display_status!=="displayed"));
    assert.ok(!JSON.stringify(contexts).includes(f.image.data));assert.ok(!JSON.stringify(contexts).includes("PRIVATE-REF"));
    assert.equal(messages.filter((m:any)=>m.method==="ui/message").length,0);
  }finally{await h.close();}
});
