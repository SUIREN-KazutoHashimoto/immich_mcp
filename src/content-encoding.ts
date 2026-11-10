import { Readable,PassThrough,Transform,addAbortSignal } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip,createInflate,createBrotliDecompress,createZstdDecompress,constants } from "node:zlib";
import { BridgeError } from "./types.js";

export const normalizeEncoding=(value:string|null|undefined)=>(value?.trim() || "identity").split(",").map(s=>s.trim().toLowerCase()).join(", ");
const allowed=new Set(["identity","gzip","x-gzip","deflate","br","zstd"]);
export function encodingView(value:string){const parts=value.split(", ");return parts.length<=4&&parts.every(p=>allowed.has(p))?value:"unsupported";}
function openSource(source:AsyncIterable<Uint8Array>):AsyncIterableIterator<Uint8Array>{
  const reader=typeof (source as any).getReader==="function"?(source as ReadableStream<Uint8Array>).getReader():undefined;
  const iterator=reader?undefined:source[Symbol.asyncIterator]();let closing:Promise<IteratorResult<Uint8Array>>|undefined;
  const done:IteratorResult<Uint8Array>={done:true,value:undefined};
  const close=()=>closing ??= (async()=>{
    if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}
    else{if(source instanceof Readable)source.destroy();await iterator!.return?.();}
    return done;
  })();
  return {[Symbol.asyncIterator](){return this;},
    next:()=>closing?Promise.resolve(done):reader?reader.read():iterator!.next(),
    return:close};
}
export async function* decodeContent(source:AsyncIterable<Uint8Array>,encoding:string,limit:number,signal?:AbortSignal):AsyncGenerator<Uint8Array>{
  if(!Number.isSafeInteger(limit)||limit<1)throw Error("Invalid decoded-content limit");
  const iterator=openSource(source),chain:Readable[]=[];let output:Readable|undefined,size=0,pumping:Promise<void>|undefined,failure:unknown;
  try{
    const codes=normalizeEncoding(encoding).split(", ").reverse();
    if(codes.length>4||codes.some(code=>!allowed.has(code)))
      throw new BridgeError("unsupported_content_encoding","Original encoding is not supported for display");
    const input=Readable.from({[Symbol.asyncIterator]:()=>iterator},{objectMode:false,highWaterMark:65536});chain.push(input);
    for(const code of codes){
      if(code==="identity")continue;
      if(code==="gzip"||code==="x-gzip")chain.push(createGunzip());
      else if(code==="deflate")chain.push(createInflate());
      else if(code==="br")chain.push(createBrotliDecompress());
      else if(code==="zstd")chain.push(createZstdDecompress({params:{[constants.ZSTD_d_windowLogMax]:23}}));
      let stageBytes=0;
      chain.push(new Transform({transform(chunk,_encoding,callback){
        stageBytes+=chunk.length;
        callback(stageBytes>limit?new BridgeError("decoded_result_limit","A decoded response stage exceeds the configured limit"):null,chunk);
      }}));
    }
    const decoded=new PassThrough({highWaterMark:65536});output=decoded;chain.push(decoded);
    for(const stream of chain)stream.on("error",()=>{});
    pumping=pipeline(chain).catch(error=>{failure=error;decoded.destroy(error);});
    if(signal)addAbortSignal(signal,decoded);
    for await(const chunk of decoded){
      signal?.throwIfAborted();size+=chunk.length;
      if(size>limit)throw new BridgeError("decoded_result_limit","Decoded response exceeds the configured inspection limit");
      yield chunk;
    }
    await pumping;if(failure)throw failure;
  }catch(error){
    if(signal?.aborted)throw new BridgeError("upstream_cancelled","Response inspection cancelled");
    if(error instanceof BridgeError)throw error;
    throw new BridgeError("response_decode_failed","Original response cannot be decoded completely");
  }finally{
    output?.destroy();for(const stream of chain)stream.destroy();
    try{await iterator.return?.();}catch{}
    await pumping;
  }
}
export async function readDecoded(source:AsyncIterable<Uint8Array>,encoding:string,limit:number,signal?:AbortSignal){
  const iterator=openSource(source),chunks:Buffer[]=[];let size=0;
  const bounded:AsyncIterableIterator<Uint8Array>={[Symbol.asyncIterator](){return this;},
    async next(){const next=await iterator.next();if(!next.done){
      size+=next.value.length;if(size>limit)throw new BridgeError("result_limit","Verification wire response exceeds limit");
    }return next;},
    return:()=>iterator.return!()
  };
  try{for await(const chunk of decodeContent(bounded,encoding,limit,signal))chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
  finally{try{await iterator.return?.();}catch{}}
}
export const decodedResponse=(response:Response,limit:number,signal?:AbortSignal)=>
  readDecoded(response.body ?? (async function*(){})(),normalizeEncoding(response.headers.get("content-encoding")),limit,signal);
