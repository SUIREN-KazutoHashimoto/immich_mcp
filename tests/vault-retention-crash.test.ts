import test from "node:test";
import assert from "node:assert/strict";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { backupVault } from "../src/vault-backup.js";
import { planBackupRetention,writeRetentionPlan,applyBackupRetention } from "../src/vault-retention.js";
import { hashFile,verifyGenerationManifest } from "../src/vault-manifest.js";
for(const phase of ["rename","unlink"] as const)test("retention resumes after actual process death following "+phase+" and protects unrelated files",{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-retention-crash-")),directory=join(root,"source"),collection=join(root,"backups"),key=randomBytes(32),serverId="retention-crash",keyFile=join(root,"vault.key"),planFile=join(root,"plan.json");
  await mkdir(directory);await mkdir(collection);await writeFile(keyFile,key);let child:ChildProcess|undefined,closed:Promise<void>|undefined;
  try{
    const v=new Vault(directory,key,serverId);await v.capture("A",(async function*(){yield Buffer.from("kept original");})(),1024);v.close();
    await backupVault({directory,key,serverId},join(collection,"old"));await backupVault({directory,key,serverId},join(collection,"new"));
    const created=await planBackupRetention(collection,1,key,serverId);assert.equal(created.plan.archives.filter(a=>a.action==="delete").length,1);await writeRetentionPlan(planFile,created.document);
    const before=await hashFile(join(collection,"new","vault.sqlite"));
    const program=`import fs from "node:fs/promises";import {syncBuiltinESMExports} from "node:module";import {applyBackupRetention} from "./src/vault-retention.ts";
const phase=process.argv[4],original=fs[phase];let first=true;
fs[phase]=async function(...args){const result=await original.apply(this,args);if(first&&String(args[0]).includes(phase==="rename"?"old":".retention-deleting-")){first=false;console.log("paused");setInterval(()=>{},1000);await new Promise(()=>{});}return result;};syncBuiltinESMExports();
await applyBackupRetention(process.argv[1],process.argv[2],await fs.readFile(process.argv[3]),"retention-crash");`;
    child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",program,collection,planFile,keyFile,phase],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stderr="",timer:ReturnType<typeof setTimeout>|undefined;child.stderr!.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
    closed=new Promise<void>(resolve=>child!.once("close",()=>resolve()));
    try{await new Promise<void>((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error("Child did not pause: "+stderr)),45000);
      child!.stdout!.on("data",chunk=>{if(chunk.toString().includes("paused"))resolve();});
      child!.once("error",reject);child!.once("close",()=>reject(Error("Child closed before pause: "+stderr)));
    });}finally{if(timer)clearTimeout(timer);}
    assert.equal(child.exitCode,null);await assert.rejects(planBackupRetention(collection,1,key,serverId));assert.equal(child.exitCode,null);
    child.kill();await closed;
    const stagedName=(await readdir(collection)).find(n=>n.startsWith(".retention-deleting-"));assert.ok(stagedName);
    const staged=join(collection,stagedName!),note=join(staged,"operator-note.txt");await writeFile(note,"KEEP THIS FILE");
    await assert.rejects(applyBackupRetention(collection,planFile,key,serverId),{code:"retention_extra_files"});
    assert.equal(await readFile(note,"utf8"),"KEEP THIS FILE");await unlink(note);
    if(phase==="unlink"){
      const intent=join(staged,".retention-delete.json"),bytes=await readFile(intent),bad=JSON.parse(bytes.toString());bad.mac=(bad.mac[0]==="0"?"1":"0")+bad.mac.slice(1);await writeFile(intent,JSON.stringify(bad));
      await assert.rejects(applyBackupRetention(collection,planFile,key,serverId),{code:"retention_authentication"});await writeFile(intent,bytes);
    }
    const applied=await applyBackupRetention(collection,planFile,key,serverId);assert.deepEqual(applied.removed,["old"]);
    assert.deepEqual(await hashFile(join(collection,"new","vault.sqlite")),before);await verifyGenerationManifest(join(collection,"new"),key,serverId);
    assert.ok(!(await readdir(collection)).some(n=>n.startsWith(".retention-deleting-")));
    assert.deepEqual((await applyBackupRetention(collection,planFile,key,serverId)).already_absent,["old"]);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;await rm(root,{recursive:true,force:true});
  }
});
