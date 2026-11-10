import test from "node:test";
import assert from "node:assert/strict";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,stat,unlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { backupVault } from "../src/vault-backup.js";
import { hashFile,verifyGenerationManifest } from "../src/vault-manifest.js";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
for(const mode of ["backup","restore"] as const)test("process death during "+mode+" preserves the source and leaves a non-runnable partial copy",{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-"+mode+"-crash-")),directory=join(root,"source"),target=join(root,"candidate"),key=randomBytes(32),keyFile=join(root,"vault.key"),serverId="offline-crash";
  await mkdir(directory);await writeFile(keyFile,key);let vault:Vault|undefined=new Vault(directory,key,serverId),child:ChildProcess|undefined,closed:Promise<void>|undefined;
  try{
    const bytes=Buffer.alloc(512*1024,11),raw=await vault.capture("A",(async function*(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);})(),bytes.length);
    vault.close();vault=undefined;
    const input=mode==="backup"?directory:join(root,"archive");
    if(mode==="restore")await backupVault({directory,key,serverId},input);
    const original=await hashFile(join(input,"objects",raw.raw_ref)),database=await hashFile(join(input,"vault.sqlite"));
    const program=`import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";import {readFile} from "node:fs/promises";import {Readable} from "node:stream";import {join} from "node:path";import {backupVault,restoreVault} from "./src/vault-backup.ts";
const original=fs.createReadStream,target=process.argv[2];
fs.createReadStream=function(path,...args){const input=original.call(this,path,...args);if(!String(path).includes("objects")||!fs.existsSync(join(target,".maintenance-incomplete")))return input;return Readable.from((async function*(){let first=true;for await(const chunk of input){yield chunk;if(first){first=false;await new Promise(resolve=>setTimeout(resolve,10000));}}})());};
syncBuiltinESMExports();const key=await readFile(process.argv[3]);
if(process.argv[4]==="backup")await backupVault({directory:process.argv[1],key,serverId:"offline-crash"},target);else await restoreVault(process.argv[1],target,key,"offline-crash");`;
    child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",program,input,target,keyFile,mode],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
    let errorText="";child.stderr!.on("data",chunk=>{errorText=(errorText+chunk.toString()).slice(-65536);});child.on("error",error=>{errorText+=error.message;});
    closed=new Promise<void>(resolve=>child!.once("close",()=>resolve()));const deadline=Date.now()+45000;let partial=false;
    while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
      try{const size=(await stat(join(target,"objects",raw.raw_ref))).size;if(size>0&&size<bytes.length){partial=true;break;}}catch{}
      await pause(10);
    }
    assert.equal(partial,true,errorText);assert.equal(child.exitCode,null);child.kill();await closed;
    assert.deepEqual(await hashFile(join(input,"objects",raw.raw_ref)),original);assert.deepEqual(await hashFile(join(input,"vault.sqlite")),database);
    assert.throws(()=>new Vault(target,key,serverId),{code:"maintenance_incomplete"});
    await unlink(join(target,".maintenance-incomplete"));if(mode==="backup")await unlink(join(target,".backup-only"));
    assert.throws(()=>new Vault(target,key,serverId),{code:"backup_only"});
    if(mode==="restore")await verifyGenerationManifest(input,key,serverId);
    vault=new Vault(directory,key,serverId);
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
    assert.deepEqual(await readFile(keyFile),key);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;
    vault?.close();await rm(root,{recursive:true,force:true});
  }
});
