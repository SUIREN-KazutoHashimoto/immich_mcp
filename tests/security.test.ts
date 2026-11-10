import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { prepare } from "../src/serializer.js";
import { registry,catalog } from "../src/registry.js";
import { validator,convertSchema } from "../src/schema.js";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { pointer,redact } from "../src/projection.js";
import { uuid,sample } from "./fixtures.js";

test("source operation triples and generated registry match exactly",async()=>{
  const source=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
  const expected=Object.entries<any>(source.paths).flatMap(([path,item])=>Object.entries<any>(item).filter(([,d])=>d.operationId).map(([m,d])=>[d.operationId,m.toUpperCase(),path].join(" "))).sort();
  const actual=registry.operations.map(o=>[o.operationId,o.method,o.path].join(" ")).sort();
  assert.equal(actual.length,279); assert.deepEqual(actual,expected);
});
test("authentication injection, arbitrary envelope and path traversal are rejected",async()=>{
  for(const headers of [{"Authorization":"Bearer other"},{"Cookie":"session=other"},{"X-API-Key":"other"}])
    await assert.rejects(prepare("http://immich/api",{operation_id:"getServerVersion",headers}),{code:"auth_injection"});
  for(const query of [{key:"other"},{slug:"other"},{sessionKey:"other"}])
    await assert.rejects(prepare("http://immich/api",{operation_id:"getServerVersion",query}),{code:"auth_injection"});
  await assert.rejects(prepare("http://immich/api",{operation_id:"getServerVersion",userId:"B"} as any),{code:"invalid_envelope"});
  await assert.rejects(prepare("http://immich/api",{operation_id:"downloadDatabaseBackup",path:{filename:".."}}),{code:"invalid_path"});
  const req=await prepare("http://immich/api",{operation_id:"downloadDatabaseBackup",path:{filename:"backup_2026-01-01.gz"}});
  assert.ok(req.url.pathname.startsWith("/api/admin/database-backups/"));
  assert.equal(req.url.search,"");assert.equal(req.url.hash,"");
});
test("schema conversion preserves recursion, nullability, required, false/zero and rejects unsafe numbers",async()=>{
  const schemas={Node:{type:"object",properties:{next:{$ref:"#/components/schemas/Node",nullable:true}}}};
  const converted=convertSchema({$ref:"#/components/schemas/Node"},schemas);
  assert.ok(converted.$defs.Node);
  validator({$ref:"#/components/schemas/Node"},schemas)({next:{next:null}});
  assert.throws(()=>validator({type:"object",required:["x"],properties:{x:{type:"boolean"}}},{})({}));
  await assert.rejects(prepare("http://immich/api",{operation_id:"searchAssets",body:{size:9007199254740992}}),{code:"unsafe_number"});
});
test("catalog cursors cannot silently continue another query or fingerprint",()=>{
  const first=catalog({limit:2});
  assert.equal(first.total,279);assert.ok(first.next_cursor);
  assert.throws(()=>catalog({query:"other",cursor:first.next_cursor!}));
  assert.deepEqual(catalog({limit:2,cursor:first.next_cursor!}).entries.map(x=>x.operation_id),registry.operations.slice(2,4).map(x=>x.operationId));
});
test("vault isolation, authenticated encryption, revision CAS and wrong master key",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-vault-"));const key=randomBytes(32);
  let v=new Vault(dir,key,"test");
  try{
    const ref=v.put("A","secret",{value:"CANARY"});
    assert.throws(()=>v.get("B",ref,"secret"));
    const row=v.db.prepare("SELECT payload FROM records WHERE principal=? AND id=?").get("A",ref) as any;
    assert.ok(!Buffer.from(row.payload).includes(Buffer.from("CANARY")));
    v.db.prepare("INSERT INTO records(principal,id,kind,payload,expires,key_version) VALUES(?,?,?,?,?,?)").run("B",ref,"secret",row.payload,Date.now()+10000,v.keyVersion);
    assert.throws(()=>v.get("B",ref,"secret"));
    v.replaceBinding("A","key-A","id-A",0);
    assert.throws(()=>v.replaceBinding("A","key-other","id-other",0));
    v.disconnect("A",1);assert.throws(()=>v.credential("A"));
    v.close();
    assert.throws(()=>new Vault(dir,randomBytes(32),"test"));
    v=new Vault(dir,key,"test");assert.deepEqual(v.get("A",ref,"secret"),{value:"CANARY"});
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
test("successful API key creation preserves encrypted raw and projects secrets",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-secret-"));const v=new Vault(dir,randomBytes(32),"test");
  try{
    v.replaceBinding("A","key-A",uuid,0);
    const decoded=sample(registry.schemas.ApiKeyCreateResponseDto!);decoded.secret="CANARY-SECRET";
    const e=new Executor("http://immich/api",v,(async()=>Response.json(decoded,{status:201})) as typeof fetch);
    const result=await e.call("A",{operation_id:"createApiKey",body:sample(registry.schemas.ApiKeyCreateDto!)});
    assert.equal(result.upstream?.status,201);
    assert.ok(result.data?.secret?.secret_ref);
    assert.ok(!JSON.stringify(result).includes("CANARY-SECRET"));
    const stored=v.get("A",result.result_ref!,"result");
    assert.ok(!JSON.stringify(pointer(stored.display,"/data")).includes("CANARY-SECRET"));
    const raw=await new Response(v.rawStream("A",stored.raw.raw_ref) as any).json();
    assert.equal(raw.secret,"CANARY-SECRET");
  }finally{v.close();await rm(dir,{recursive:true,force:true});}
});
test("JSONL secret rules respect record discriminator",()=>{
  const r=redact("getSyncStream",200,{type:"AuthUserV2",data:{pinCode:"123456",isPasswordLoginEnabled:true}},()=>"secret_ref",true);
  assert.deepEqual(r.data.pinCode,{secret_ref:"secret_ref"});
  assert.equal(r.data.isPasswordLoginEnabled,true);
});
