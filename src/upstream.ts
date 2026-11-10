import { Pool,type Dispatcher } from "undici";
import { Readable } from "node:stream";
import { BridgeError } from "./types.js";

type Input=Parameters<typeof fetch>[0];
export interface UpstreamOptions {concurrency?:number;connectTimeoutMs?:number;idleTimeoutMs?:number;maxQueued?:number;reuseConnections?:boolean;}
export class UpstreamError extends BridgeError {
  constructor(code:string,readonly phase:"connect"|"headers"|"body"|"request",readonly mayHaveBeenSent:boolean){
    super(code,mayHaveBeenSent?"Upstream transfer failed; request effects may be unknown":"Upstream connection failed before request transmission");
  }
}
type Dispatch=(input:Input,init?:RequestInit,beforeSend?:()=>void,retain?:boolean)=>Promise<Response>;
const responseLeases=new WeakMap<Response,()=>void>();
export function releaseUpstream(response:Response){const release=responseLeases.get(response);responseLeases.delete(response);release?.();}
export type ManagedFetch=typeof fetch & {dispatch:Dispatch;close():Promise<void>};
export async function sendUpstream(http:typeof fetch,input:Input,init:RequestInit,beforeSend:()=>void,retain=false){
  const dispatch=(http as Partial<ManagedFetch>).dispatch;
  if(dispatch)return dispatch(input,init,beforeSend,retain);
  beforeSend();return http(input,init);
}
export function transportError(error:unknown,phase:UpstreamError["phase"],connectionFailed=false):UpstreamError{
  if(error instanceof UpstreamError)return phase==="body"?new UpstreamError(error.code,"body",true):error;
  const code=(error as any)?.code ?? (error as any)?.cause?.code;
  if(phase==="request"||phase==="connect"){
    if(code==="UND_ERR_CONNECT_TIMEOUT")return new UpstreamError("upstream_connect_timeout","connect",false);
    if(["ENOTFOUND","EAI_AGAIN","ECONNREFUSED","ENETUNREACH","EHOSTUNREACH"].includes(code))
      return new UpstreamError("upstream_connect_failed","connect",false);
    // TLS record failures can also happen after request transmission. Only an
    // actual pool connectionError establishes that HTTP was never sent.
    if(connectionFailed)return new UpstreamError(typeof code==="string"&&/CERT|TLS|SSL/.test(code)?"upstream_tls_failed":"upstream_connect_failed","connect",false);
  }
  if(code==="UND_ERR_HEADERS_TIMEOUT")return new UpstreamError("upstream_idle_timeout","headers",true);
  if(code==="UND_ERR_BODY_TIMEOUT")return new UpstreamError("upstream_idle_timeout","body",true);
  if(code==="UND_ERR_ABORTED"||code==="ABORT_ERR"||(error as any)?.name==="AbortError")
    return new UpstreamError("upstream_cancelled",phase,true);
  return new UpstreamError("upstream_transport_interrupted",phase,true);
}
type Waiter={signal:AbortSignal;abort:()=>void;resolve:(release:()=>void)=>void;reject:(reason:unknown)=>void};
export class Upstream {
  readonly concurrency:number;readonly connectTimeoutMs:number;readonly idleTimeoutMs:number;readonly maxQueued:number;
  readonly fetch:ManagedFetch;private pool:Pool;private active=0;private queue:Waiter[]=[];private connectionFailures=new WeakSet<object>();
  private stopping=new AbortController();private closing?:Promise<void>;private base:URL;
  constructor(base:string,options:UpstreamOptions={}){
    this.base=new URL(base);
    if(!["http:","https:"].includes(this.base.protocol)||this.base.username||this.base.password||this.base.search||this.base.hash)
      throw Error("Invalid fixed upstream");
    this.concurrency=options.concurrency ?? 8;this.connectTimeoutMs=options.connectTimeoutMs ?? 10000;
    this.idleTimeoutMs=options.idleTimeoutMs ?? 30000;this.maxQueued=options.maxQueued ?? 1024;
    for(const n of [this.concurrency,this.connectTimeoutMs,this.idleTimeoutMs,this.maxQueued])
      if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw Error("Invalid upstream resource limit");
    if(options.reuseConnections!==undefined&&typeof options.reuseConnections!=="boolean")throw Error("Invalid upstream connection reuse setting");
    this.pool=new Pool(this.base.origin,{connections:this.concurrency,pipelining:options.reuseConnections===false?0:1,allowH2:false,
      connectTimeout:this.connectTimeoutMs,headersTimeout:this.idleTimeoutMs,bodyTimeout:this.idleTimeoutMs,maxHeaderSize:65536});
    this.pool.on("connectionError",(_origin,_targets,error)=>{if(error&&typeof error==="object")this.connectionFailures.add(error);});
    this.fetch=Object.assign(((input:Input,init?:RequestInit)=>this.send(input,init)) as typeof fetch,
      {dispatch:(input:Input,init?:RequestInit,beforeSend?:()=>void,retain?:boolean)=>this.send(input,init,beforeSend,retain),close:()=>this.close()});
  }
  private lease(){
    let released=false;
    return ()=>{if(released)return;released=true;this.active--;
      for(let next;(next=this.queue.shift())!==undefined;){
        next.signal.removeEventListener("abort",next.abort);
        if(next.signal.aborted){next.reject(new BridgeError("upstream_cancelled","Unsent upstream request cancelled"));continue;}
        this.active++;next.resolve(this.lease());break;
      }
    };
  }
  private async acquire(signal:AbortSignal){
    if(signal.aborted)throw new BridgeError("upstream_cancelled","Unsent upstream request cancelled");
    if(this.active<this.concurrency){this.active++;return this.lease();}
    if(this.queue.length>=this.maxQueued)throw new BridgeError("upstream_busy","Upstream waiting capacity is exhausted");
    return new Promise<()=>void>((resolve,reject)=>{
      const entry:Waiter={signal,resolve,reject,abort:()=>{
        const i=this.queue.indexOf(entry);if(i>=0)this.queue.splice(i,1);
        reject(new BridgeError("upstream_cancelled","Unsent upstream request cancelled"));
      }};
      signal.addEventListener("abort",entry.abort,{once:true});this.queue.push(entry);
    });
  }
  private async send(input:Input,init:RequestInit={},beforeSend?:()=>void,retain=false):Promise<Response>{
    const request=input instanceof Request?input:undefined;
    const url=new URL(request?.url ?? String(input));
    const prefix=this.base.pathname.replace(/\/$/,"");
    if(url.origin!==this.base.origin||url.username||url.password||url.hash||!(url.pathname===prefix||url.pathname.startsWith(prefix+"/")))
      throw new BridgeError("upstream_target","Request does not belong to the fixed upstream");
    if(init.redirect!==undefined&&init.redirect!=="manual")throw new BridgeError("upstream_redirect","Only manual redirects are supported");
    const headers=new Headers(init.headers ?? request?.headers);
    if(!headers.has("accept-encoding"))headers.set("accept-encoding","identity");
    const method=(init.method ?? request?.method ?? "GET").toUpperCase();
    const provided=Object.hasOwn(init,"body")?init.body:request?.body;
    let body:Dispatcher.DispatchOptions["body"];
    if(provided===undefined||provided===null)body=null;
    else if(typeof provided==="string"||provided instanceof Uint8Array)body=provided;
    else if(provided instanceof URLSearchParams)body=provided.toString();
    else if(provided instanceof ArrayBuffer)body=Buffer.from(provided);
    else if(typeof (provided as any)[Symbol.asyncIterator]==="function")body=Readable.from(provided as any,{objectMode:false,highWaterMark:65536});
    else throw new BridgeError("upstream_body","Unsupported internal request body representation");
    const signal=AbortSignal.any([this.stopping.signal,...(init.signal?[init.signal]:request?[request.signal]:[])]);
    let release:()=>void;
    try{release=await this.acquire(signal);}catch(error){if(body instanceof Readable)body.destroy();throw error;}
    try{if(signal.aborted)throw new BridgeError("upstream_cancelled","Unsent upstream request cancelled");beforeSend?.();}catch(error){release();if(body instanceof Readable)body.destroy();throw error;}
    try{
      const response=await this.pool.request({path:url.pathname+url.search,method:method as Dispatcher.HttpMethod,headers:Object.fromEntries(headers),
        body,signal,idempotent:false,headersTimeout:this.idleTimeoutMs,bodyTimeout:this.idleTimeoutMs});
      const responseHeaders=new Headers();
      for(const [name,value]of Object.entries(response.headers))for(const item of Array.isArray(value)?value:value===undefined?[]:[value])responseHeaders.append(name,item);
      const complete=()=>{if(!retain)release();};
      const owned=(value:Response)=>{if(retain)responseLeases.set(value,release);return value;};
      const source=response.body;source.on("error",complete);
      if(method==="HEAD"||[204,205,304].includes(response.statusCode)){
        await source.dump();complete();return owned(new Response(null,{status:response.statusCode,headers:responseHeaders}));
      }
      const iterator=source[Symbol.asyncIterator]();
      const stream=new ReadableStream<Uint8Array>({
        async pull(controller){
          try{
            const next=await iterator.next();
            if(next.done){complete();controller.close();}else controller.enqueue(next.value);
          }catch(error){complete();controller.error(transportError(error,"body"));}
        },
        async cancel(){source.destroy();try{await iterator.return?.();}catch{}finally{complete();}}
      },{highWaterMark:0});
      try{return owned(new Response(stream,{status:response.statusCode,headers:responseHeaders}));}
      catch(error){source.destroy();release();throw error;}
    }catch(error){release();if(body instanceof Readable)body.destroy();throw transportError(error,"request",!!error&&typeof error==="object"&&(this.connectionFailures.has(error)||this.connectionFailures.has((error as any).cause)));}
  }
  close(){return this.closing ??= (async()=>{this.stopping.abort();await this.pool.destroy();})();}
}
