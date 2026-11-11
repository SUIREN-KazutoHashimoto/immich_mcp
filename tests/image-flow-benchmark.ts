// Run with: pnpm exec tsx tests/image-flow-benchmark.ts <baseline dist directory>
// Synthetic upstream only; real local HTTP/MCP; no ChatGPT inference or portal timing.
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:http";
import { createHash,randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from "jose";
import { Application } from "../src/app.js";
import { serve } from "../src/http.js";
import { registry,operation } from "../src/registry.js";
import { sample,uuid } from "./fixtures.js";

const baseline=resolve(process.argv[2]??"");assert.ok(process.argv[2],"baseline dist directory required");
const legacy=await import(pathToFileURL(join(baseline,"src/app.js")).href);
const legacyHttp=await import(pathToFileURL(join(baseline,"src/http.js")).href);
const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="benchmark";
const issuer="https://benchmark.cloudflareaccess.com",publicOrigin="https://mcp.example.test";
const token=await new SignJWT({iss:issuer,aud:"benchmark",sub:"synthetic-benchmark",exp:Math.floor(Date.now()/1000)+3600}).setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
const originals:Buffer[]=[];
for(let seed=0;seed<3;seed++){
  const raw=Buffer.alloc(1200*900*3);let n=seed+1;
  for(let i=0;i<raw.length;i++){n=(Math.imul(n,1664525)+1013904223)>>>0;raw[i]=seed===2?n>>>24:(Math.floor(i/3)%1200+seed*65)%256;}
  originals.push(await sharp(raw,{raw:{width:1200,height:900,channels:3}}).jpeg({quality:88}).toBuffer());
}
const asset={...sample(operation("searchRandom").definition.responses["200"].content["application/json"].schema)[0],id:uuid,type:"IMAGE"};
const savedInfo=console.info;console.info=()=>{};
const reports:any[]=[],hashes:string[][]=[];
try{
  for(const mode of ["baseline_auto","baseline_sync","candidate"]){
    const dir=await mkdtemp(join(tmpdir(),"immich-benchmark-"));let frame=0,upstream=0,app:any,http:any;
    try{
      app=await (mode.startsWith("baseline")?legacy.Application:Application).create({upstream:"http://immich/api",publicOrigin,issuer,audience:"benchmark",jwksUrl:issuer+"/cdn-cgi/access/certs",directory:dir,masterKey:randomBytes(32),host:"127.0.0.1",port:0},{databasePath:":memory:",versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0,jwks:createLocalJWKSet({keys:[jwk]}),http:async(input:any)=>{
        const url=new URL(String(input));if(url.pathname==="/api/server/version")return Response.json({major:3,minor:3,patch:5,prerelease:null});
        upstream++;return url.pathname==="/api/search/random"?Response.json([asset]):new Response(new Uint8Array(originals[frame]! ),{headers:{"content-type":"image/jpeg"}});
      }});
      const principal=await app.access.authenticate(token);app.vault.replaceBinding(principal,"SYNTHETIC-BENCHMARK-KEY",uuid,0);
      http=await(mode.startsWith("baseline")?legacyHttp.serve:serve)(app);const port=http.address.port;
      let id=0,roundTrips=0,wireBytes=0;
      const rpc=async(method:string,params:any)=>{
        const body=JSON.stringify({jsonrpc:"2.0",id:++id,method,params});
        const raw=await new Promise<string>((accept,reject)=>{const req=request({hostname:"127.0.0.1",port,path:"/mcp",method:"POST",agent:false,headers:{host:new URL(publicOrigin).host,"cf-access-jwt-assertion":token,"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":"2025-11-25"}},res=>{const parts:Buffer[]=[];res.on("data",p=>parts.push(p));res.on("end",()=>accept(Buffer.concat(parts).toString()));});req.on("error",reject);req.end(body);});
        roundTrips++;wireBytes+=Buffer.byteLength(raw);
        const reply=JSON.parse(raw.trim().startsWith("{")?raw:raw.split("\n").filter(l=>l.startsWith("data:")).at(-1)!.slice(5));assert.ok(!reply.error,JSON.stringify(reply.error));return reply.result;
      };
      const call=(name:string,args:any)=>rpc("tools/call",{name,arguments:args});
      await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic-benchmark",version:"1"}});
      const description=(await call("immich_api_describe",{operation_ids:["viewAsset","searchRandom"]})).structuredContent;
      roundTrips=0;wireBytes=0;upstream=0;const samples:any[]=[],pixelHashes:string[]=[];
      for(let i=0;i<30;i++){
        frame=i%3;const before=performance.now(),callsBefore=roundTrips,bytesBefore=wireBytes;let result:any;
        if(mode.startsWith("baseline")){
          await call("immich_api_call",{operation_id:"searchRandom",body:{size:1,filter:{type:{eq:"IMAGE"}},withExif:false,withPeople:false},execution_mode:"sync"});
          const ack=(await call("immich_api_call",{operation_id:"viewAsset",path:{id:uuid},query:{size:"preview"},result_mode:"reference",execution_mode:mode==="baseline_sync"?"sync":"auto"})).structuredContent;
          let done:any=ack.state==="completed"?{state:"completed",result:ack}:undefined;
          while(!done||done.state!=="completed"){done=(await call("immich_get_job",{job_ref:ack.job_ref})).structuredContent;if(done.state!=="completed")await new Promise(r=>setTimeout(r,100));}
          result=await call("immich_read_image",{result_ref:done.result.result_ref});
        }else result=await call("immich_get_image",{source:"random"});
        const part=result.content.find((p:any)=>p.type==="image");assert.ok(part);pixelHashes.push(createHash("sha256").update(Buffer.from(part.data,"base64")).digest("hex"));
        samples.push({ms:performance.now()-before,mcp_calls:roundTrips-callsBefore,response_bytes:wireBytes-bytesBefore,output_bytes:(result.structuredContent??result._meta.image_info).size_bytes});
      }
      hashes.push(pixelHashes);const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
      reports.push({mode,samples:30,median_ms:sorted[14],p95_ms:sorted[28],mcp_calls:roundTrips,upstream_calls:upstream,response_bytes:wireBytes,description_complete_inline:!description.truncated,definition_count:Object.keys(description.definitions).length,measurements:samples});
    }finally{await http?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
  }
}finally{console.info=savedInfo;}
assert.deepEqual(hashes[0],hashes[2],"optimized pipeline must preserve all preview bytes");assert.deepEqual(hashes[1],hashes[2]);
console.log(JSON.stringify({format:"immich-image-flow-benchmark",scope:"real local HTTP MCP with synthetic upstream; no Cloudflare, ChatGPT inference or phone timing",pending_job_poll_interval_ms:100,quality_bytes_identical:true,reports}));
