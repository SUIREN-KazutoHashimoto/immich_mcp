import { createServer,type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Application } from "./app.js";
export async function serve(app:Application) {
  const active=new Set<AbortController>(),tasks=new Set<Promise<void>>();
  const publicHost=new URL(app.config.publicOrigin).host;
  const server=createServer((incoming,outgoing)=>{
    const controller=new AbortController();active.add(controller);
    controller.signal.addEventListener("abort",()=>{incoming.destroy();outgoing.destroy();},{once:true});
    incoming.on("aborted",()=>controller.abort());
    outgoing.on("close",()=>{if(!outgoing.writableEnded)controller.abort();});
    const task=(async()=>{
      try{
        const url=new URL(incoming.url ?? "/",app.config.publicOrigin);
        const local=/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(incoming.headers.host ?? "");
        const health=["/health/live","/health/ready"].includes(url.pathname);
        if(url.origin!==app.config.publicOrigin || incoming.headers.host!==publicHost && !(health&&local)){
          outgoing.writeHead(403,{"cache-control":"no-store"});outgoing.end("Host is not allowed");return;
        }
        const headers=new Headers();
        for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i]!,incoming.rawHeaders[i+1]!);
        const body=["GET","HEAD"].includes(incoming.method ?? "GET")?undefined:Readable.toWeb(incoming);
        const request=new Request(url,{method:incoming.method,headers,signal:controller.signal,
          ...(body?{body:body as ReadableStream<Uint8Array>,duplex:"half"}:{})} as RequestInit);
        const response=await app.fetch(request);
        outgoing.statusCode=response.status;
        response.headers.forEach((v,k)=>{if(k!=="set-cookie")outgoing.setHeader(k,v);});
        const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader("set-cookie",cookies);
        if(response.body && incoming.method!=="HEAD")
          await pipeline(Readable.fromWeb(response.body as any),outgoing,{signal:controller.signal});
        else outgoing.end();
      }catch{
        if(outgoing.destroyed||controller.signal.aborted)return;
        if(!outgoing.headersSent){outgoing.writeHead(500,{"content-type":"application/json","cache-control":"no-store"});outgoing.end('{"error":{"code":"http_error"}}');}
        else outgoing.destroy();
      }
    })().finally(()=>{active.delete(controller);tasks.delete(task);});
    tasks.add(task);
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise<void>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(app.config.port,app.config.host,()=>{server.off("error",reject);resolve();});
  });
  let closing:Promise<void>|undefined;
  return {server,address:server.address(),close:()=>closing ??= (async()=>{
    app.stopping=true;
    const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const controller of active)controller.abort();
    await app.jobs.close();await Promise.allSettled([...tasks]);await app.close();
    server.closeAllConnections();await stopped;
  })()};
}
