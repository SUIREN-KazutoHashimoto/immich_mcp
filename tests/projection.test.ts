import test from "node:test";
import assert from "node:assert/strict";
import { safeShape } from "../src/projection.js";
import { registry } from "../src/registry.js";
import { sample } from "./fixtures.js";
test("known response unions retain each valid formal edit parameter variant",()=>{
  const union=registry.schemas.AssetEditActionItemResponseDto!.properties.parameters;
  for(const branch of union.anyOf){
    const value=sample(branch);
    assert.deepEqual(safeShape(value,union),value);
    assert.throws(()=>safeShape({...value,unmappedSecret:"CANARY"},union),{code:"projection_mismatch"});
  }
  assert.throws(()=>safeShape({invalid:"CANARY"},union),{code:"projection_mismatch"});
});
test("oneOf projection requires exactly one valid branch",()=>{
  const schema={oneOf:[{type:"integer"},{type:"number"}]};
  assert.throws(()=>safeShape(1,schema),{code:"projection_mismatch"});
  assert.equal(safeShape(1.5,schema),1.5);
});

test("unconstrained response values cannot expose arbitrary primitive or object secrets",()=>{
  for(const value of ["ARBITRARY-CANARY",{password:"ARBITRARY-CANARY"},["ARBITRARY-CANARY"]]){
    assert.throws(()=>safeShape(value,{}),{code:"projection_mismatch"});
    assert.deepEqual(safeShape(value,{},0,()=>({withheld:true})),{withheld:true});
  }
});

test("OpenAPI boolean exclusive bounds become numeric JSON Schema bounds",async()=>{
  const {convertSchema,validator}=await import("../src/schema.js");
  const schema={type:"integer",minimum:0,exclusiveMinimum:true};
  assert.equal(convertSchema(schema,{}).exclusiveMinimum,0);
  const check=validator(schema,{});check(1);assert.throws(()=>check(0),{code:"invalid_input"});
  validator({type:"number",maximum:2,exclusiveMaximum:false},{})(2);
});
