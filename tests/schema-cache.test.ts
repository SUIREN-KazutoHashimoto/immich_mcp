import test from "node:test";
import assert from "node:assert/strict";
import { SchemaValidatorCache, convertSchema, schemaValidationStats } from "../src/schema.js";
import { prepare } from "../src/serializer.js";
import type { Schema } from "../src/types.js";

test("equivalent validation requests reuse a compiler without coercion, defaults or input mutation", () => {
  const cache = new SchemaValidatorCache();
  const schema = {type:"object",required:["flag","count"],additionalProperties:false,
    properties:{flag:{type:"boolean"},count:{type:"integer",minimum:0},optional:{type:"string",default:"unused"}}};
  const check = cache.validator(schema, {});
  for (let i=0;i<600;i++) {
    const current = cache.validator(structuredClone(schema), {});
    assert.equal(current, check);
    const value = {flag:false,count:0}; current(value);
    assert.deepEqual(value,{flag:false,count:0});
  }
  for (const value of [{flag:"false",count:0},{flag:false,count:"0"},{flag:false},{flag:false,count:0,extra:true}])
    assert.throws(()=>check(value),{code:"invalid_input"});
  assert.equal(cache.stats().compilations,1);
  assert.equal(cache.stats().hits,600);
});

test("root and reachable-reference mutations get new checks while cached enum snapshots remain stable", () => {
  const cache = new SchemaValidatorCache();
  const values = Array.from({length:300},(_,i)=>i);
  const schema = {type:"integer",enum:values};
  const original = cache.validator(schema,{});
  original(0);
  values[0] = 777;
  const changed = cache.validator(schema,{});
  assert.notEqual(changed,original);
  changed(777); assert.throws(()=>changed(0),{code:"invalid_input"});
  original(0); assert.throws(()=>original(777),{code:"invalid_input"});
  values[0] = 0;
  assert.equal(cache.validator(schema,{}),original);

  const root = {$ref:"#/components/schemas/Value"};
  const schemas = {Value:{type:"string",minLength:2}};
  cache.validator(root,schemas)("ab");
  schemas.Value.minLength=4;
  assert.throws(()=>cache.validator(root,schemas)("ab"),{code:"invalid_input"});
  cache.validator(root,schemas)("abcd");
  // Unreachable definitions must not change the compiled input or exhaust the cache.
  assert.equal(cache.validator(root,{...schemas,Unused:{type:"number"}}),cache.validator(root,schemas));
});

test("isolated compilers preserve recursive refs, nullable data, formats, unions and OpenAPI bounds", () => {
  const cache = new SchemaValidatorCache();
  const schemas:Record<string,Schema> = {Node:{type:"object",additionalProperties:false,
    properties:{id:{type:"string",format:"uuid"},next:{$ref:"#/components/schemas/Node",nullable:true}}}};
  const check = cache.validator({$ref:"#/components/schemas/Node"},schemas);
  check({id:"00000000-0000-4000-8000-000000000001",next:{next:null}});
  assert.throws(()=>check({id:"invalid"}),{code:"invalid_input"});
  assert.throws(()=>check({next:{unexpected:"value"}}),{code:"invalid_input"});
  cache.validator({type:"number",minimum:0,exclusiveMinimum:false},{})(0);
  assert.throws(()=>cache.validator({type:"number",minimum:0,exclusiveMinimum:true},{})(0),{code:"invalid_input"});
  const union=cache.validator({oneOf:[{type:"integer"},{type:"number"}]},{});
  union(1.5); assert.throws(()=>union(1),{code:"invalid_input"});
  cache.validator({type:"object",additionalProperties:false},{})({});
  assert.throws(()=>cache.validator({type:"object",additionalProperties:false},{})({x:false}),{code:"invalid_input"});
});

test("LRU eviction and the serialized-schema budget bound retained definitions without invalidating held checks", () => {
  const cache = new SchemaValidatorCache({maxEntries:2});
  const a=cache.validator({type:"integer",minimum:1},{});
  const b=cache.validator({type:"integer",minimum:2},{});
  assert.equal(cache.validator({type:"integer",minimum:1},{}),a);
  cache.validator({type:"integer",minimum:3},{});
  assert.equal(cache.validator({type:"integer",minimum:1},{}),a);
  assert.notEqual(cache.validator({type:"integer",minimum:2},{}),b);
  b(2); assert.throws(()=>b(1),{code:"invalid_input"});
  assert.equal(cache.stats().entries,2);
  assert.equal(cache.stats().evictions,2);

  const schema={type:"string",description:"x".repeat(400)};
  const size=Buffer.byteLength(JSON.stringify(convertSchema(schema,{})));
  const bytes=new SchemaValidatorCache({maxEntries:20,maxSchemaBytes:size+50});
  for(let i=0;i<20;i++)bytes.validator({...schema,description:"x".repeat(399)+String.fromCharCode(65+i)},{})("valid");
  assert.equal(bytes.stats().entries,1);
  assert.ok(bytes.stats().schemaBytes<=size+50);
  assert.equal(bytes.stats().evictions,19);
});

test("failed compilations and invalid references leave no retained entry and cannot contaminate other schema IDs", () => {
  const cache = new SchemaValidatorCache();
  for(let i=0;i<10;i++)assert.throws(()=>cache.validator({type:"not-a-type"},{}));
  assert.equal(cache.stats().entries,0);
  assert.equal(cache.stats().schemaBytes,0);
  assert.throws(()=>cache.validator({$ref:"https://example.invalid/schema"},{}));
  const number=cache.validator({$id:"urn:mcp:fixture",type:"number"},{});
  const string=cache.validator({$id:"urn:mcp:fixture",type:"string"},{});
  number(0);string("valid");
  assert.throws(()=>number("invalid"),{code:"invalid_input"});
  assert.throws(()=>string(0),{code:"invalid_input"});
  assert.equal(cache.stats().entries,2);
});

test("oversized and non-cloneable definitions remain uncached while limits reject unsafe values", () => {
  const cache = new SchemaValidatorCache({maxSchemaBytes:1});
  const a=cache.validator({type:"boolean"},{});
  const b=cache.validator({type:"boolean"},{});
  a(false);b(true);assert.notEqual(a,b);
  assert.equal(cache.stats().entries,0);
  assert.equal(cache.stats().uncached,2);
  const annotations=new SchemaValidatorCache();
  const schema={type:"boolean","x-local-annotation":()=>undefined};
  annotations.validator(schema,{})(false);
  assert.equal(annotations.stats().entries,0);
  assert.equal(annotations.stats().uncached,1);
  annotations.validator({type:"boolean",default:undefined},{})(false);
  annotations.validator({type:"boolean","x-local-annotation":{toJSON:()=>"changed"}},{})(false);
  assert.equal(annotations.stats().entries,0);
  assert.equal(annotations.stats().uncached,3);
  for(const value of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>new SchemaValidatorCache({maxEntries:value}));
    assert.throws(()=>new SchemaValidatorCache({maxSchemaBytes:value}));
  }
});

test("repeated production request serialization reuses validators on the normal operation route",async()=>{
  const before=schemaValidationStats();
  for(let i=0;i<250;i++){
    const request=await prepare("http://immich/api",{operation_id:"getAssetStatistics",
      query:{isFavorite:false,isTrashed:false}});
    assert.equal(request.url.searchParams.get("isFavorite"),"false");
    assert.equal(request.url.searchParams.get("isTrashed"),"false");
  }
  const after=schemaValidationStats();
  assert.ok(after.compilations-before.compilations<=2);
  assert.ok(after.hits-before.hits>=498);
  assert.ok(after.entries<=after.maxEntries);
  assert.ok(after.schemaBytes<=after.maxSchemaBytes);
});
