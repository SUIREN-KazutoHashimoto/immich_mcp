import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";
import { imageViewerResource } from "../src/image-viewer.js";

async function host(result:any,rejectContext=false){
  const browser=await chromium.launch({headless:true,timeout:45000,...(process.env.MCP_TEST_BROWSER_CHANNEL?{channel:process.env.MCP_TEST_BROWSER_CHANNEL}:process.platform==="win32"?{channel:"msedge"}:{})});
  const context=await browser.newContext({viewport:{width:1000,height:760}});
  const page=await context.newPage();
  const html='<!doctype html><html><body style="margin:16px"><iframe title="Immich preview" style="border:0;width:min(100%,680px);height:700px"></iframe><script>window.messages=[];window.addEventListener("message",e=>{if(e.source!==document.querySelector("iframe").contentWindow)return;const m=e.data;window.messages.push(m);if(m.id){e.source.postMessage({jsonrpc:"2.0",id:m.id,...(m.method==="ui/update-model-context"&&window.rejectContext?{error:{code:-32601,message:"unsupported"}}:{result:{}})},"*");}if(m.method==="ui/notifications/initialized"){e.source.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:window.fixture},"*");}});</script></body></html>';
  await context.route("**/*",async route=>{
    const url=new URL(route.request().url());
    await route.fulfill({status:200,contentType:"text/html",body:url.pathname==="/viewer"?imageViewerResource().text:html});
  });
  await page.goto("https://image-viewer.test/");
  await page.evaluate(({result,rejectContext})=>{
    (window as any).fixture=result;(window as any).rejectContext=rejectContext;
    document.querySelector("iframe")!.src="/viewer";
  },{result,rejectContext});
  const frame=page.frameLocator("iframe");
  const send=async(payload:any)=>page.evaluate(p=>document.querySelector("iframe")!.contentWindow!.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:p},"*"),payload);
  return {browser,context,page,frame,send,close:async()=>{await context.close();await browser.close();}};
}
async function fixture(){
  const bytes=await sharp({create:{width:240,height:120,channels:3,background:"#dd2233"}}).jpeg().toBuffer();
  const image={type:"image",data:bytes.toString("base64"),mimeType:"image/jpeg"};
  return {image,result:{content:[image,{type:"text",text:"Preview ready"}],structuredContent:{width:240,height:120},_meta:{image_content:image}}};
}

test("image viewer renders pixels and forwards them through the host context on an explicit explanation request",{timeout:90000},async()=>{
  const f=await fixture(),h=await host(f.result);
  try{
    await h.frame.getByRole("img",{name:"Immichの画像プレビュー"}).waitFor({state:"visible"});
    assert.deepEqual(await h.frame.locator("img").evaluate((img:HTMLImageElement)=>[img.naturalWidth,img.naturalHeight]),[240,120]);
    assert.match(await h.frame.getByRole("link",{name:"画像を保存"}).getAttribute("href") ?? "",/^blob:/);
    await h.frame.getByRole("button",{name:"この画像を説明",exact:true}).click();
    await h.frame.getByRole("status").filter({hasText:"画像の説明を依頼しました。"}).waitFor();
    const messages=await h.page.evaluate(()=>(window as any).messages);
    assert.equal(messages.filter((m:any)=>m.method==="ui/initialize").length,1);
    assert.deepEqual(messages.find((m:any)=>m.method==="ui/update-model-context").params.content,[f.image]);
    const message=messages.find((m:any)=>m.method==="ui/message");
    assert.equal(message.params.role,"user");assert.equal(message.params.content.length,1);
    await h.page.setViewportSize({width:390,height:760});
    assert.ok(await h.frame.locator("body").evaluate(el=>el.scrollWidth<=document.documentElement.clientWidth),"mobile viewer must not overflow");
    if(process.env.MCP_IMAGE_VIEWER_SCREENSHOT)await h.page.screenshot({path:process.env.MCP_IMAGE_VIEWER_SCREENSHOT,fullPage:true});
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
  }finally{await h.close();}
});
