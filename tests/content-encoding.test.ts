import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync,deflateSync,brotliCompressSync,zstdCompressSync } from "node:zlib";
import { decodeContent,readDecoded,decodedResponse } from "../src/content-encoding.js";
const split=(bytes:Uint8Array)=>(async function*(){for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7);})();
async function collect(source:AsyncIterable<Uint8Array>){const parts:Buffer[]=[];for await(const c of source)parts.push(Buffer.from(c));return Buffer.concat(parts);}
test("content decoding preserves split Unicode for all supported encodings and reverses stacked encodings",async()=>{
  const plain=Buffer.from("snow-\u96ea-camera-\ud83d\udcf7".repeat(300));
  for(const [encoding,bytes]of [["identity",plain],["gzip",gzipSync(plain)],["x-gzip",gzipSync(plain)],["deflate",deflateSync(plain)],["br",brotliCompressSync(plain)],["zstd",zstdCompressSync(plain)],["gzip, br",brotliCompressSync(gzipSync(plain))]] as const)
    assert.deepEqual(await collect(decodeContent(split(bytes),encoding,plain.length)),plain,encoding);
});
test("invalid and truncated compressed responses fail explicitly without returning a successful body",async()=>{
  const gzip=gzipSync(Buffer.from("valid prefix".repeat(100)));
  await assert.rejects(collect(decodeContent(split(gzip.subarray(0,-5)),"gzip",65536)),{code:"response_decode_failed"});
  await assert.rejects(collect(decodeContent(split(Buffer.from("not deflate")),"deflate",65536)),{code:"response_decode_failed"});
});
test("decoded expansion is bounded and the source is closed on failure or early consumer return",{timeout:5000},async()=>{
  const large=Buffer.alloc(1024*1024,97),gzip=gzipSync(large);let closed=0,accepted=0;
  const source=(async function*(){try{yield gzip;}finally{closed++;}})();
  await assert.rejects((async()=>{for await(const chunk of decodeContent(source,"gzip",1024))accepted+=chunk.length;})(),{code:"decoded_result_limit"});
  assert.ok(accepted<=1024);assert.equal(closed,1);
  const emptyFrames=Buffer.concat(Array.from({length:200},()=>gzipSync(Buffer.alloc(0))));
  await assert.rejects(collect(decodeContent(split(gzipSync(emptyFrames)),"gzip, gzip",1024)),{code:"decoded_result_limit"});
  for(const encoding of ["identity","gzip"]){
    let cancelled=false;
    const response=new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(encoding==="gzip"?gzip:large);},cancel(){cancelled=true;}}));
    for await(const _chunk of decodeContent(response.body!,encoding,2*1024*1024))break;
    assert.equal(cancelled,true);
  }
});
test("unknown coding and excessive coding layers cancel an unconsumed HTTP body",async()=>{
  for(const encoding of ["private-token","gzip, gzip, gzip, gzip, gzip"]){
    let cancelled=false;
    const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{"content-encoding":encoding}});
    await assert.rejects(decodedResponse(response,1024),{code:"unsupported_content_encoding"});assert.equal(cancelled,true);
  }
});
test("small verification reads bound both received wire bytes and decoded bytes",async()=>{
  const gzip=gzipSync(Buffer.from("x".repeat(100000)));
  await assert.rejects(readDecoded(split(gzip),"gzip",1024),{code:"decoded_result_limit"});
  await assert.rejects(readDecoded(split(Buffer.alloc(100)),"identity",20),{code:"result_limit"});
  const empty=gzipSync(Buffer.alloc(0));
  await assert.rejects(readDecoded(split(empty),"gzip",10),{code:"result_limit"});
});
test("aborted inspection closes the decoder input without exposing parser internals",{timeout:5000},async()=>{
  const controller=new AbortController();controller.abort();let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(gzipSync(Buffer.from("data")));},cancel(){cancelled=true;}}));
  await assert.rejects(collect(decodeContent(response.body!,"gzip",1024,controller.signal)),{code:"upstream_cancelled"});assert.equal(cancelled,true);
});
