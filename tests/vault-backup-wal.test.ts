import test from "node:test";
import assert from "node:assert/strict";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,mkdir,writeFile,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { backupVault,restoreVault } from "../src/vault-backup.js";
import { hashFile } from "../src/vault-manifest.js";
test("a crashed source's committed WAL is included without rewriting the source database or WAL",{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-backup-source-wal-")),directory=join(root,"source"),key=randomBytes(32),keyFile=join(root,"vault.key"),serverId="source-wal";
  await mkdir(directory);await writeFile(keyFile,key);let v:Vault|undefined=new Vault(directory,key,serverId),child:ChildProcess|undefined,closed:Promise<void>|undefined;
  v.close();v=undefined;
  try{
    const program=`import {readFile} from "node:fs/promises";import {Vault} from "./src/vault.ts";const v=new Vault(process.argv[1],await readFile(process.argv[2]),"source-wal");v.put("A","secret",{value:"COMMITTED-IN-WAL"},Number.MAX_SAFE_INTEGER,"wal-secret");console.log("committed");setInterval(()=>{},1000);`;
    child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",program,directory,keyFile],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stderr="",timer:ReturnType<typeof setTimeout>|undefined;child.stderr!.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
    closed=new Promise<void>(resolve=>child!.once("close",()=>resolve()));
    try{await new Promise<void>((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error("Child did not commit: "+stderr)),45000);
      child!.stdout!.on("data",chunk=>{if(chunk.toString().includes("committed"))resolve();});
      child!.once("error",reject);child!.once("close",()=>reject(Error("Child closed before observation: "+stderr)));
    });}finally{if(timer)clearTimeout(timer);}
    child.kill();await closed;
    const database=join(directory,"vault.sqlite"),wal=database+"-wal";assert.ok((await stat(wal)).size>0);
    const mainBefore=await hashFile(database),walBefore=await hashFile(wal),archive=join(root,"backup");
    await backupVault({directory,key,serverId},archive);
    assert.deepEqual(await hashFile(database),mainBefore);assert.deepEqual(await hashFile(wal),walBefore);
    await restoreVault(archive,join(root,"restored"),key,serverId);v=new Vault(join(root,"restored"),key,serverId);
    assert.equal(v.get("A","wal-secret","secret").value,"COMMITTED-IN-WAL");
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;
    v?.close();await rm(root,{recursive:true,force:true});
  }
});
