import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {buffer} from "node:stream/consumers";
import {randomBytes} from "node:crypto";
import {safeShape,unreviewedObject} from "../src/projection.js";
import {SyncProjection} from "../src/sync-projection.js";
import {ResultPages} from "../src/result-pages.js";
import {Executor} from "../src/executor.js";
import {Vault} from "../src/vault.js";
import {registry} from "../src/registry.js";
import {sample,uuid} from "./fixtures.js";

test("open empty properties are opaque while closed and constrained objects retain unknown-field guards",()=>{
  const value={nested:{password:"EMPTY-OBJECT-CANARY"}},withheld=()=>({withheld:true});
  for(const schema of [{type:"object"},{type:"object",properties:{}},{type:"object",properties:{},additionalProperties:true}]){
    assert.equal(unreviewedObject(schema),true);
    assert.deepEqual(safeShape(value,schema,0,withheld),{withheld:true});
    assert.throws(()=>safeShape(value,schema),{code:"projection_mismatch"});
  }
  for(const schema of [
    {type:"object",properties:{},additionalProperties:false},
    {type:"object",properties:{},minProperties:1},
    {type:"object",properties:{},maxProperties:1},
    {type:"object",properties:{known:{type:"string"}}},
    {type:"object",properties:{},additionalProperties:{type:"string"}},
    {allOf:[{type:"object",properties:{},additionalProperties:false}]},
    {allOf:[{type:"object",properties:{},additionalProperties:false},{type:"object",properties:{},additionalProperties:true}]},
    {allOf:[{type:"object",properties:{},additionalProperties:true},{type:"object",properties:{},additionalProperties:false}]}
  ])assert.throws(()=>safeShape(value,schema,0,withheld),{code:"projection_mismatch"});
  assert.deepEqual(value,{nested:{password:"EMPTY-OBJECT-CANARY"}});
});

test("streaming plugin method schemas retain encrypted originals and withhold opaque fields for every result shape",async()=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-empty-object-"));assert.ok(resolve(root).startsWith(parent+sep));
  const vault=new Vault(root,randomBytes(32),"test",":memory:");
  const plugin=sample(registry.schemas.PluginResponseDto!),method=plugin.methods[0],canary="EMPTY-SCHEMA-SECRET-CANARY";
  method.schema={type:"object",properties:{password:{default:canary}},nested:[{value:canary.repeat(10000)}]};
  let response:any;const e=new Executor("http://127.0.0.1:22835/api",vault,async()=>Response.json(response),1024*1024,1024*1024,{jsonValueBytes:1024});
  try{
    vault.replaceBinding("A","synthetic",uuid,0);
    for(const schema of [{}, {type:"object",properties:{password:{default:canary}},nested:[{value:canary.repeat(10000)}]}]){
    method.schema=schema;
    for(const [op,data,select]of [
      ["getPlugin",plugin,(r:any)=>r.data.methods[0].schema],
      ["searchPlugins",[plugin],(r:any)=>r.data[0].methods[0].schema],
      ["searchPluginMethods",[method],(r:any)=>r.data[0].schema]
    ]as const){
      response=data;const r=await e.call("A",{operation_id:op,...(op==="getPlugin"?{path:{id:uuid}}:{})});
      assert.equal(r.state,"completed");assert.equal(r.truncated,false);assert.equal(r.upstream?.status,200);
      assert.deepEqual(select(r),Object.keys(schema).length===0?{}:{withheld:true,reason:"unreviewed_structure",original_available_in_control_ui:true});
      assert.ok(!JSON.stringify(r).includes(canary));
      const saved=vault.get("A",r.result_ref!,"result"),bytes=await buffer(vault.rawStream("A",saved.raw.raw_ref));
      assert.deepEqual(JSON.parse(bytes.toString()),data);assert.throws(()=>vault.get("B",r.result_ref!,"result"));
    }
    }
  }finally{await e.close();vault.close();await rm(root,{recursive:true,force:true});}
});

test("an undeclared field in a known response object still fails projection and retains its protected original",async()=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-known-object-"));assert.ok(resolve(root).startsWith(parent+sep));
  const vault=new Vault(root,randomBytes(32),"test",":memory:"),body={images:0,total:0,videos:0,password:"UNKNOWN-ROOT-CANARY"};
  const e=new Executor("http://127.0.0.1:22835/api",vault,async()=>Response.json(body));
  try{
    vault.replaceBinding("A","synthetic",uuid,0);
    const r=await e.call("A",{operation_id:"getUserStatisticsAdmin",path:{id:uuid}});
    assert.equal(r.state,"failed");assert.equal(r.diagnostic?.code,"projection_mismatch");assert.equal(r.data,null);
    assert.ok(!JSON.stringify(r).includes(body.password));
    const saved=vault.get("A",r.result_ref!,"result"),bytes=await buffer(vault.rawStream("A",saved.raw.raw_ref));
    assert.deepEqual(JSON.parse(bytes.toString()),body);
  }finally{await e.close();vault.close();await rm(root,{recursive:true,force:true});}
});

test("declared empty object data remains exact in sync completion and reset records",async()=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-empty-sync-"));assert.ok(resolve(root).startsWith(parent+sep));
  const vault=new Vault(root,randomBytes(32),"test",":memory:");
  try{
    for(const type of ["SyncCompleteV1","SyncResetV1"]){
      const input={type,data:{},ack:type+"|complete"},projection=new SyncProjection(vault,"A",()=>"unused");
      assert.deepEqual(safeShape(input.data,registry.schemas[type]!,0,()=>({withheld:true})),{});
      projection.push(Buffer.from(JSON.stringify(input)+"\n"));
      const meta=projection.finish(),rows=new ResultPages(vault,"A",undefined,meta.stream_id).read(0,10);
      assert.equal(meta.complete,true);assert.equal(meta.terminal,type);assert.deepEqual(rows,[input]);
    }
  }finally{vault.close();await rm(root,{recursive:true,force:true});}
});
