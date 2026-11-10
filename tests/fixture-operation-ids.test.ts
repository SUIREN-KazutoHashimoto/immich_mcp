import test from "node:test";
import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Fixture callers use dynamic ApiCall strings, so tsc cannot reject a mistyped
// operation ID. Check literal calls against the attached original, not a model.
function literalCalls(source:string,file:string){
  const found:{operation_id:string;line:number}[]=[],tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const visit=(node:ts.Node)=>{
    if(ts.isPropertyAssignment(node)&&
      (ts.isIdentifier(node.name)||ts.isStringLiteral(node.name))&&node.name.text==="operation_id"&&
      (ts.isStringLiteral(node.initializer)||ts.isNoSubstitutionTemplateLiteral(node.initializer))){
      found.push({operation_id:node.initializer.text,line:tree.getLineAndCharacterOfPosition(node.initializer.getStart(tree)).line+1});
    }
    ts.forEachChild(node,visit);
  };
  visit(tree);return found;
}
test("every literal fixture operation ID exists in the pinned official OpenAPI",async t=>{
  const sourceDirectory=new URL("../src/",import.meta.url);
  const original=JSON.parse(await readFile(new URL("../immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",import.meta.url),"utf8"));
  const ids=Object.values<any>(original.paths).flatMap(path=>Object.values<any>(path).filter(op=>op&&typeof op.operationId==="string").map(op=>op.operationId));
  assert.equal(ids.length,279);const known=new Set(ids);assert.equal(known.size,279);
  const files=(await readdir(sourceDirectory)).filter(name=>/^integration-(?:[a-z]+-)*fixtures\.ts$/.test(name)).toSorted();
  assert.ok(files.length>=11,"the workflow plan and all existing feature plans must be included");
  const invalid:string[]=[];let calls=0;
  for(const file of files){
    const url=new URL(file,sourceDirectory),found=literalCalls(await readFile(url,"utf8"),file);assert.ok(found.length>0,file);calls+=found.length;
    for(const call of found)if(!known.has(call.operation_id))invalid.push(fileURLToPath(url)+":"+call.line+" "+call.operation_id);
  }
  // A source service/URL name is not necessarily its public operationId.
  assert.deepEqual(literalCalls('call({operation_id:"searchMetadata"});call({operation_id:"searchAssets"});',"probe.ts")
    .filter(call=>!known.has(call.operation_id)).map(call=>call.operation_id),["searchMetadata"]);
  assert.deepEqual(invalid,[],"unknown literal fixture operation IDs");
  t.diagnostic("checked "+calls+" literal calls in "+files.length+" feature modules against 279 official operation IDs; dynamic call tables are exercised separately by HTTP tests");
});
