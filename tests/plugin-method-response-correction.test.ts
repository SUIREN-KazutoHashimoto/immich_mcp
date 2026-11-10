import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {createHash,randomBytes} from "node:crypto";
import {tmpdir} from "node:os";
import {resolve,join,sep} from "node:path";
import {createServer} from "node:http";
import {once} from "node:events";
import {applyPluginMethodSchemaCorrection} from "../scripts/plugin-method-response-correction.js";
import {registry,operation} from "../src/registry.js";
import {Executor} from "../src/executor.js";
import {Vault} from "../src/vault.js";
import {sample,uuid} from "./fixtures.js";
const ids=["getPlugin","searchPlugins","searchPluginMethods"],baseline={version:registry.version,commit:registry.commit,sha256:registry.sha256};
async function contract(){return JSON.parse(await readFile(new URL("../contracts/plugin-method-response-correction.v3.3.5.json",import.meta.url),"utf8"));}
async function originals(){
 const api=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
 return registry.operations.map(o=>{const copy=structuredClone(o);if(ids.includes(o.operationId)){
  copy.definition.responses=structuredClone(api.paths[o.path][o.method.toLowerCase()].responses);delete copy.override;
 }return copy;});
}
test("generated nullable plugin schemas are private to the three200 responses and leave pinned components unchanged",async()=>{
 const c=await contract();
 for(const [component,hash]of [["PluginMethodResponseDto",c.method_component_sha256],["PluginResponseDto",c.plugin_component_sha256]])
  assert.equal(createHash("sha256").update(JSON.stringify(registry.schemas[component])).digest("hex"),hash);
 const expected=applyPluginMethodSchemaCorrection(await originals(),registry.schemas,c,baseline);
 for(const id of ids){
  const op=operation(id),want=expected.find(o=>o.operationId===id)!;assert.deepEqual(op.definition.responses,want.definition.responses);
  const schema=op.definition.responses["200"].content["application/json"].schema;
  const root=id==="getPlugin"?schema:schema.items,method=id==="searchPluginMethods"?root:root.properties.methods.items;
  assert.equal(method.properties.schema.nullable,true);
  const restored=structuredClone(method);delete restored.properties.schema.nullable;assert.deepEqual(restored,registry.schemas.PluginMethodResponseDto);
  assert.equal(op.override!.facts.find((f:any)=>f.fact_id==="nullable_plugin_method_schema").value.runtime_verified,false);
 }
 assert.equal(registry.schemas.PluginMethodResponseDto!.properties.schema.nullable,undefined);
});
test("nullable method correction preserves all other fields, request schemas, statuses, permissions and operations",async()=>{
 const before=await originals(),schemas=structuredClone(registry.schemas),after=applyPluginMethodSchemaCorrection(before,registry.schemas,await contract(),baseline);
 assert.equal(after.length,279);assert.deepEqual(registry.schemas,schemas);
 const changes=[];
 for(let i=0;i<before.length;i++){
  const a=before[i]!,b=after[i]!;if(!ids.includes(a.operationId)){assert.deepEqual(b,a);continue;}
  changes.push(a.operationId);
  const {responses:ar,...ad}=a.definition,{responses:br,...bd}=b.definition;
  assert.deepEqual(ad,bd);assert.deepEqual(Object.keys(ar),Object.keys(br));assert.deepEqual(a.parameters,b.parameters);assert.deepEqual(a.auth,b.auth);
  for(const status of Object.keys(ar))if(status!=="200")assert.deepEqual(ar[status],br[status]);
 }
 assert.deepEqual(changes.toSorted(),ids.toSorted());
});
test("stale metadata, schema drift, missing or duplicate targets and double correction are rejected",async()=>{
 const c=await contract(),ops=await originals();
 for(const bad of [{...c,version:2},{...c,source_commit:"wrong"},{...c,openapi_sha256:"wrong"},{...c,method_component_sha256:"wrong"},
  {...c,plugin_component_sha256:"wrong"},{...c,operation_ids:ids.slice(1)},{...c,operation_ids:[...ids,"getAssetInfo"]},
  {...c,source_urls:c.source_urls.slice(1)},{...c,extra:true}])assert.throws(()=>applyPluginMethodSchemaCorrection(ops,registry.schemas,bad,baseline));
 const schemas=structuredClone(registry.schemas);schemas.PluginMethodResponseDto!.properties.schema.nullable=true;
 assert.throws(()=>applyPluginMethodSchemaCorrection(ops,schemas,c,baseline));
 assert.throws(()=>applyPluginMethodSchemaCorrection(ops.filter(o=>o.operationId!=="getPlugin"),registry.schemas,c,baseline));
 assert.throws(()=>applyPluginMethodSchemaCorrection([...ops,ops.find(o=>o.operationId==="getPlugin")!],registry.schemas,c,baseline));
 assert.throws(()=>applyPluginMethodSchemaCorrection(applyPluginMethodSchemaCorrection(ops,registry.schemas,c,baseline),registry.schemas,c,baseline));
});
test("native HTTP accepts null method schemas, withholds arbitrary objects and rejects invalid types and unreviewed statuses",async()=>{
 const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-nullable-method-"));assert.ok(resolve(root).startsWith(parent+sep));
 const vault=new Vault(root,randomBytes(32),"test",":memory:"),canary="METHOD-SCHEMA-CANARY",errors:unknown[]=[];
 let mode="null",requests=0;
 const server=createServer((req,res)=>{
  try{
   requests++;assert.equal(req.headers["x-api-key"],"synthetic");for(const h of ["authorization","cookie","cf-access-jwt-assertion"])assert.equal(req.headers[h],undefined);
   const path=new URL(req.url!,"http://127.0.0.1").pathname,plugin=sample(registry.schemas.PluginResponseDto!),method=plugin.methods[0];
   method.schema=mode==="null"?null:mode==="object"?{password:canary}:canary;
   const data=path==="/api/plugins/methods"?[method]:path==="/api/plugins"?[plugin]:plugin;
   res.writeHead(mode==="status"?202:200,{"content-type":"application/json"});res.end(JSON.stringify(data));
  }catch(error){errors.push(error);res.writeHead(500);res.end("{}");}
 });server.listen(0,"127.0.0.1");await once(server,"listening");
 const e=new Executor("http://127.0.0.1:"+(server.address()as any).port+"/api",vault);
 try{
  vault.replaceBinding("A","synthetic",uuid,0);
  for(const value of ["null","object","invalid"])for(const id of ids){
   mode=value;const r=await e.call("A",{operation_id:id,...(id==="getPlugin"?{path:{id:uuid}}:{})});
   assert.ok(!JSON.stringify(r).includes(canary));assert.equal(r.upstream?.status,200);assert.throws(()=>vault.get("B",r.result_ref!,"result"));
   if(mode==="invalid"){assert.equal(r.state,"failed");assert.equal(r.diagnostic?.code,"response_schema_mismatch");}
   else{
    assert.equal(r.state,"completed");assert.equal(r.truncated,false);
    const method=id==="getPlugin"?r.data.methods[0]:id==="searchPlugins"?r.data[0].methods[0]:r.data[0];
    assert.deepEqual(method.schema,mode==="null"?null:{withheld:true,reason:"unreviewed_structure",original_available_in_control_ui:true});
   }
  }
  mode="status";const r=await e.call("A",{operation_id:"getPlugin",path:{id:uuid}});
  assert.equal(r.upstream?.status,202);assert.equal(r.data,null);assert.ok(r.diagnostic);assert.ok(!JSON.stringify(r).includes(canary));
  assert.equal(requests,10);assert.deepEqual(errors,[]);
 }finally{await e.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));vault.close();await rm(root,{recursive:true,force:true});}
});
