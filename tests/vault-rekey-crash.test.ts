import test from "node:test";
import assert from "node:assert/strict";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,stat,unlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { hashFile } from "../src/vault-manifest.js";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test("process death during re-encryption preserves the source and blocks the incomplete target",{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-rekey-crash-")),directory=join(root,"source"),target=join(root,"candidate");
  const oldKey=randomBytes(32),newKey=randomBytes(32),oldFile=join(root,"old.key"),newFile=join(root,"next.key"),serverId="crash-rekey";
  await mkdir(directory);await writeFile(oldFile,oldKey);await writeFile(newFile,newKey);
  let vault:Vault|undefined=new Vault(directory,oldKey,serverId),child:ChildProcess|undefined,closed:Promise<void>|undefined;
  try{
    const bytes=Buffer.alloc(512*1024,7),raw=await vault.capture("A",(async function*(){for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);})(),bytes.length);
    const keyVersion=vault.keyVersion,before=await hashFile(join(directory,"objects",raw.raw_ref));vault.close();vault=undefined;
    const program=`import {readFile} from "node:fs/promises";import {Readable} from "node:stream";import {Vault} from "./src/vault.ts";import {rekeyVault} from "./src/vault-rekey.ts";
const original=Vault.prototype.storedRawStream;
Vault.prototype.storedRawStream=function(principal,id){const input=original.call(this,principal,id);return Readable.from((async function*(){let first=true;for await(const chunk of input){yield chunk;if(first){first=false;await new Promise(resolve=>setTimeout(resolve,10000));}}})());};
await rekeyVault({directory:process.argv[1],key:await readFile(process.argv[3]),serverId:"crash-rekey"},process.argv[2],await readFile(process.argv[4]));`;
    child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",program,directory,target,oldFile,newFile],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
    let errorText="";child.stderr!.on("data",chunk=>{errorText=(errorText+chunk.toString()).slice(0,65536);});child.on("error",error=>{errorText+=error.message;});
    closed=new Promise<void>(resolve=>child!.once("close",()=>resolve()));
    const deadline=Date.now()+20000;let partial=false;
    while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
      try{const size=(await stat(join(target,"objects",raw.raw_ref))).size;if(size>0&&size<bytes.length){partial=true;break;}}catch{}
      await pause(5);
    }
    assert.equal(partial,true,errorText);assert.equal(child.exitCode,null);child.kill();await closed;
    assert.deepEqual(await hashFile(join(directory,"objects",raw.raw_ref)),before);
    assert.ok((await stat(join(target,".maintenance-incomplete"))).isFile());
    assert.throws(()=>new Vault(target,newKey,serverId),{code:"maintenance_incomplete"});
    await unlink(join(target,".maintenance-incomplete"));
    assert.throws(()=>new Vault(target,oldKey,serverId),{code:"store_identity_mismatch"});
    vault=new Vault(directory,oldKey,serverId);assert.equal(vault.keyVersion,keyVersion);
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
    assert.equal((await readFile(oldFile)).length,32);assert.equal((await readFile(newFile)).length,32);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;
    vault?.close();await rm(root,{recursive:true,force:true});
  }
});
