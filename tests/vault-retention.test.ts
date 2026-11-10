import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes,createHmac,hkdfSync } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir,cp,rename,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Vault } from "../src/vault.js";
import { backupVault } from "../src/vault-backup.js";
import { planBackupRetention,writeRetentionPlan,applyBackupRetention } from "../src/vault-retention.js";
import { verifyGenerationManifest,hashFile } from "../src/vault-manifest.js";
import { maintenanceServer } from "../scripts/vault.js";
const upstream="http://immich/api",serverId=maintenanceServer({IMMICH_BASE_URL:upstream});
async function fixture(run:(root:string,collection:string,key:Buffer)=>Promise<void>,count=3){
  const root=await mkdtemp(join(tmpdir(),"immich-retention-")),directory=join(root,"source"),collection=join(root,"backups"),key=randomBytes(32);
  await mkdir(directory);await mkdir(collection);
  const vault=new Vault(directory,key,serverId);vault.replaceBinding("A","API-CANARY","id",0);await vault.capture("A",(async function*(){yield Buffer.from("original");})(),1024);vault.close();
  try{
    for(const name of ["z-old","m-middle","a-new"].slice(0,count))await backupVault({directory,key,serverId},join(collection,name));
    await run(root,collection,key);
  }finally{await rm(root,{recursive:true,force:true});}
}
test("retention only plans deletions, then keeps the newest verified backups and applies idempotently",()=>fixture(async(root,collection,key)=>{
  const names=await readdir(collection),before=await hashFile(join(root,"source","vault.sqlite")),created=await planBackupRetention(collection,1,key,serverId),planFile=join(root,"plan.json");
  assert.deepEqual(created.plan.archives.map(a=>[a.name,a.action]),[["a-new","keep"],["m-middle","delete"],["z-old","delete"]]);assert.deepEqual(created.plan.skipped,[]);
  for(const name of names)await verifyGenerationManifest(join(collection,name),key,serverId);
  await writeRetentionPlan(planFile,created.document);await assert.rejects(writeRetentionPlan(planFile,created.document),{code:"EEXIST"});
  assert.ok(!JSON.stringify(created).includes("API-CANARY"));
  const applied=await applyBackupRetention(collection,planFile,key,serverId);
  assert.deepEqual(applied.removed,["m-middle","z-old"]);assert.deepEqual(applied.retained,["a-new"]);await verifyGenerationManifest(join(collection,"a-new"),key,serverId);
  const repeated=await applyBackupRetention(collection,planFile,key,serverId);assert.deepEqual(repeated.removed,[]);assert.deepEqual(repeated.already_absent,["m-middle","z-old"]);
  assert.deepEqual(await hashFile(join(root,"source","vault.sqlite")),before);
}));
test("mixed-key backups, duplicate identities and directories containing unrelated files remain untouched",()=>fixture(async(root,collection,key)=>{
  const foreignKey=randomBytes(32),foreign=join(root,"foreign-source");await mkdir(foreign);const v=new Vault(foreign,foreignKey,serverId);v.close();
  await backupVault({directory:foreign,key:foreignKey,serverId},join(collection,"foreign"));
  await cp(join(collection,"z-old"),join(collection,"duplicate"),{recursive:true});
  await writeFile(join(collection,"m-middle","private.key"),key);
  await mkdir(join(collection,"notes"));await writeFile(join(collection,"notes","personal.txt"),"KEEP-ME");
  const result=await planBackupRetention(collection,1,key,serverId);
  assert.deepEqual(result.plan.archives.map(a=>a.name),["a-new"]);
  assert.ok(result.plan.skipped.some(a=>a.name==="foreign"&&a.code==="manifest_authentication"));
  for(const name of ["z-old","duplicate"])assert.ok(result.plan.skipped.some(a=>a.name===name&&a.code==="duplicate_backup_id"));
  assert.ok(result.plan.skipped.some(a=>a.name==="m-middle"&&a.code==="retention_extra_files"));
  const plan=join(root,"plan.json");await writeRetentionPlan(plan,result.document);assert.deepEqual((await applyBackupRetention(collection,plan,key,serverId)).removed,[]);
  assert.deepEqual(await readFile(join(collection,"m-middle","private.key")),key);assert.equal(await readFile(join(collection,"notes","personal.txt"),"utf8"),"KEEP-ME");
}));
test("changed retained or deletion candidates stop the whole preflight before any deletion",()=>fixture(async(root,collection,key)=>{
  const result=await planBackupRetention(collection,1,key,serverId),plan=join(root,"plan.json");await writeRetentionPlan(plan,result.document);
  const note=join(collection,"z-old","operator-note.txt");await writeFile(note,"DO NOT DELETE");
  await assert.rejects(applyBackupRetention(collection,plan,key,serverId),{code:"retention_extra_files"});
  for(const name of ["z-old","m-middle","a-new"])await verifyGenerationManifest(join(collection,name),key,serverId);
  assert.equal(await readFile(note,"utf8"),"DO NOT DELETE");await unlink(note);
  const main=join(collection,"a-new","vault.sqlite"),bytes=await readFile(main);const bad=Buffer.from(bytes);bad[100]=bad[100]!^1;await writeFile(main,bad);
  await assert.rejects(applyBackupRetention(collection,plan,key,serverId),{code:"manifest_mismatch"});
  assert.ok((await readdir(collection)).includes("z-old"));assert.ok((await readdir(collection)).includes("m-middle"));await writeFile(main,bytes);
}));
test("tampered plans, traversal, changed roots and zero retention cannot remove any backup",()=>fixture(async(root,collection,key)=>{
  for(const keep of [0,-1,1001,1.5])await assert.rejects(planBackupRetention(collection,keep,key,serverId),{code:"retention_keep"});
  const created=await planBackupRetention(collection,1,key,serverId),planFile=join(root,"plan.json");await writeRetentionPlan(planFile,created.document);
  await assert.rejects(applyBackupRetention(collection,planFile,randomBytes(32),serverId),{code:"retention_authentication"});
  const envelope={...created.document,payload:created.document.payload.replace("z-old","../source")};await writeFile(planFile,JSON.stringify(envelope));
  await assert.rejects(applyBackupRetention(collection,planFile,key,serverId),{code:"retention_authentication"});
  const altered=structuredClone(created.plan);altered.archives.find(a=>a.action==="delete")!.name="../source";
  const payload=JSON.stringify(altered),derived=Buffer.from(hkdfSync("sha256",key,Buffer.from(serverId),Buffer.from("immich-mcp-retention-plan-v1"),32));
  const mac=createHmac("sha256",derived).update("immich-mcp-retention-plan-v1\n").update(payload).digest("hex");derived.fill(0);
  await writeFile(planFile,JSON.stringify({format:1,payload,mac}));await assert.rejects(applyBackupRetention(collection,planFile,key,serverId),{code:"invalid_retention"});
  await writeFile(planFile,JSON.stringify(created.document));
  const moved=join(root,"moved");await rename(collection,moved);await cp(moved,collection,{recursive:true});
  await assert.rejects(applyBackupRetention(collection,planFile,key,serverId),{code:"invalid_retention"});
  for(const name of ["z-old","m-middle","a-new"])await verifyGenerationManifest(join(collection,name),key,serverId);
}));
test("a replacement archive directory with identical signed files is rejected by its physical identity",()=>fixture(async(root,collection,key)=>{
  const created=await planBackupRetention(collection,1,key,serverId),plan=join(root,"plan.json");await writeRetentionPlan(plan,created.document);
  const path=join(collection,"z-old"),moved=join(root,"moved-old");await rename(path,moved);await cp(moved,path,{recursive:true});
  await assert.rejects(applyBackupRetention(collection,plan,key,serverId),{code:"retention_changed"});
  assert.ok((await readdir(collection)).includes("m-middle"));await verifyGenerationManifest(path,key,serverId);
}));
test("offline retention CLI requires an explicit plan, separate key and fixed upstream but no Cloudflare configuration",()=>fixture(async(root,collection,key)=>{
  const keyFile=join(root,"vault.key"),plan=join(root,"plan.json");await writeFile(keyFile,key);
  const env={...process.env,IMMICH_BASE_URL:upstream};for(const name of Object.keys(env))if(name.startsWith("CF_ACCESS")||name==="VAULT_MASTER_KEY_FILE")delete (env as any)[name];
  const run=(args:string[])=>spawnSync(process.execPath,["--import","tsx","scripts/vault.ts",...args],{cwd:process.cwd(),env,encoding:"utf8",timeout:45000});
  const planned=run(["retention-plan","--directory",collection,"--keep","1","--key",keyFile,"--out",plan]);
  assert.equal(planned.status,0,planned.stderr);assert.equal(JSON.parse(planned.stdout).state,"retention_planned");
  assert.ok((await readdir(collection)).includes("z-old"));
  const applied=run(["retention-apply","--directory",collection,"--plan",plan,"--key",keyFile]);assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).removed,["z-old"]);await verifyGenerationManifest(join(collection,"m-middle"),key,serverId);
  assert.ok(!planned.stdout.includes("API-CANARY"));assert.ok(!applied.stdout.includes("API-CANARY"));
},2));
