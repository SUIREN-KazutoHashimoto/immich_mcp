import test from "node:test";
import assert from "node:assert/strict";
import { JsonLines } from "../src/jsonl.js";
import { prepare } from "../src/serializer.js";
import { uuid } from "./fixtures.js";
test("JSONL keeps UTF-8 boundaries, order, blank lines and explicit EOF",()=>{
  const bytes=Buffer.from(JSON.stringify({name:"\u96ea",index:0})+"\n\n"+JSON.stringify({index:1})+"\n");
  const parser=new JsonLines();const out:any[]=[];
  for(const byte of bytes)out.push(...parser.push(Uint8Array.of(byte)));
  parser.finish();assert.deepEqual(out,[{name:"\u96ea",index:0},{index:1}]);
  assert.throws(()=>parser.push(new Uint8Array()));
  const broken=new JsonLines();assert.throws(()=>broken.push(Buffer.from("{bad}\n")),{code:"invalid_jsonl"});
  const truncated=new JsonLines();truncated.push(Buffer.from('{"ok":true}'));
  assert.throws(()=>truncated.finish(),{code:"incomplete_jsonl"});
  const invalid=new JsonLines();invalid.push(Uint8Array.of(0xe9));assert.throws(()=>invalid.finish(),{code:"invalid_utf8"});
  assert.throws(()=>new JsonLines(2).push(Buffer.from("123")),{code:"line_limit"});
});
test("HLS dedicated header, zero and encoded path arguments reach prepared wire",async()=>{
  const req=await prepare("http://immich/api",{operation_id:"getSegment",
    path:{id:uuid,sessionId:uuid,variantIndex:0,filename:"seg_0.m4s"},headers:{"x-immich-hls-msn":0}});
  assert.equal(req.headers.get("x-immich-hls-msn"),"0");
  assert.ok(req.url.pathname.endsWith("/0/seg_0.m4s"));
});
