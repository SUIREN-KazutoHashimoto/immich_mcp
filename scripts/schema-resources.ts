import { validator, schemaValidationStats } from "../src/schema.js";

if (!globalThis.gc) throw new Error("Run Node with --expose-gc");
const collect = globalThis.gc;
const schema = {
  type:"object",required:["id","value"],
  properties:{id:{type:"string",format:"uuid"},value:{type:"integer",minimum:0},
    next:{$ref:"#/components/schemas/Node",nullable:true}},
  additionalProperties:false,
};
const schemas = {Node:{type:"object",properties:{next:{$ref:"#/components/schemas/Node",nullable:true}},additionalProperties:false}};
const value = {id:"00000000-0000-4000-8000-000000000001",value:0,next:null};
function snapshot(label:string,start:number) {
  collect();
  return {label,elapsed_ms:Math.round(performance.now()-start),heap_used:process.memoryUsage().heapUsed,
    cache:schemaValidationStats()};
}
const observations = [snapshot("baseline",performance.now())];
let unique = 0;
for (const [label,count,distinct] of [
  ["same_schema_300",300,false],["same_schema_600",300,false],
  ["unique_schema_300",300,true],["unique_schema_600",300,true],["unique_schema_1200",600,true],
] as const) {
  const start = performance.now();
  for(let i=0;i<count;i++)validator(distinct?{...schema,description:String(unique++)}:schema,schemas)(value);
  observations.push(snapshot(label,start));
}
console.log(JSON.stringify({scope:"synthetic_local_schema_validation",node:process.version,observations},null,2));
