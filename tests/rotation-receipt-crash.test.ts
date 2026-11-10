import test from "node:test";
import assert from "node:assert/strict";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,stat,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { Executor } from "../src/executor.js";
import { Jobs } from "../src/jobs.js";
import { uuid } from "./fixtures.js";
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const resolver=()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}});
for(const phase of ["before_commit","after_commit"] as const)test("self-rotation process death "+phase+" preserves an atomic binding/result/job state without replay",{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-rotation-atomic-")),directory=join(root,"data"),key=randomBytes(32),keyFile=join(root,"vault.key"),marker=join(root,"paused.json"),counter=join(root,"requests.log");
  await mkdir(directory);await writeFile(keyFile,key);let vault:Vault|undefined=new Vault(directory,key,"rotation-crash"),child:ChildProcess|undefined,closed:Promise<void>|undefined;
  vault.replaceBinding("A","OLD-KEY-CANARY",uuid,0);vault.close();vault=undefined;
  try{
    const program=`import {readFileSync,writeFileSync,appendFileSync} from "node:fs";import {Vault} from "./src/vault.ts";import {Executor} from "./src/executor.ts";import {Jobs} from "./src/jobs.ts";import {sample,uuid} from "./tests/fixtures.ts";import {registry} from "./src/registry.ts";
const [directory,keyFile,marker,counter,phase]=process.argv.slice(1),v=new Vault(directory,readFileSync(keyFile),"rotation-crash"),original=v.put.bind(v);let ack;
v.put=function(p,kind,data,...args){const before=phase==="before_commit"&&kind==="result"&&data.revision===2,after=phase==="after_commit"&&kind==="job"&&data.result?.state==="completed"&&!v.db.isTransaction;
if(before){const id=original(p,kind,data,...args);writeFileSync(marker,JSON.stringify({job_ref:ack.job_ref,result_ref:id,transaction:v.db.isTransaction}),{flush:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return id;}
if(after){writeFileSync(marker,JSON.stringify({job_ref:ack.job_ref,result_ref:data.result.result_ref,transaction:v.db.isTransaction}),{flush:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
return original(p,kind,data,...args);};
const e=new Executor("http://immich/api",v,async()=>{appendFileSync(counter,"rotate\\n");return Response.json({...sample(registry.schemas.ApiKeyCreateResponseDto),id:uuid,secret:"NEW-KEY-CANARY"},{status:201});});
const jobs=new Jobs(v,e,()=>({file:async()=>{throw Error();},secret:async()=>{throw Error();}}),{autoStart:false});
ack=await jobs.submit("A",{operation_id:"rotateApiKey",path:{id:uuid}});jobs.start();await jobs.idle();`;
    child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",program,directory,keyFile,marker,counter,phase],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
    let stderr="";child.stderr!.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-16384);});child.on("error",error=>{stderr+=error.message;});
    closed=new Promise<void>(resolve=>child!.once("close",()=>resolve()));let paused=false;const deadline=Date.now()+45000;
    while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
      try{if((await stat(marker)).size>0){paused=true;break;}}catch{}await wait(10);
    }
    assert.equal(paused,true,stderr);const saved=JSON.parse(await readFile(marker,"utf8"));assert.equal(saved.transaction,phase==="before_commit");assert.equal(child.exitCode,null);
    child.kill();await closed;
    vault=new Vault(directory,key,"rotation-crash");let replayed=0;const e=new Executor("http://immich/api",vault,(async()=>{replayed++;throw Error("Recovered work must not replay");}) as typeof fetch),jobs=new Jobs(vault,e,resolver);
    try{
      await jobs.idle();assert.equal(replayed,0);assert.equal(await readFile(counter,"utf8"),"rotate\n");
      const result=jobs.get("A",saved.job_ref),stored=vault.get("A",saved.result_ref,"result");
      assert.equal(vault.credential("A").revision,phase==="before_commit"?1:2);
      assert.equal(vault.credential("A").key,phase==="before_commit"?"OLD-KEY-CANARY":"NEW-KEY-CANARY");
      if(phase==="before_commit"){
        assert.equal(result.state,"outcome_unknown");assert.equal(result.result,null);assert.equal(stored.display.state,"outcome_unknown");assert.equal(stored.binding_transition,undefined);
      }else{
        assert.equal(result.state,"completed");assert.equal(result.result.result_ref,saved.result_ref);assert.equal(stored.display.state,"completed");assert.equal(stored.binding_transition.to_revision,2);
      }
      assert.ok(!JSON.stringify(result).includes("NEW-KEY-CANARY"));
      const plain=Buffer.from(await new Response(vault.rawStream("A",stored.raw.raw_ref) as any).arrayBuffer());assert.ok(plain.includes(Buffer.from("NEW-KEY-CANARY")));
      assert.ok(!(await readFile(join(directory,"objects",stored.raw.raw_ref))).includes(Buffer.from("NEW-KEY-CANARY")));
    }finally{await jobs.close();await e.close();}
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;vault?.close();await rm(root,{recursive:true,force:true});
  }
});
