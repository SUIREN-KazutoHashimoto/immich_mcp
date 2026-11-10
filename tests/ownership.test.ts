import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
test("SQLite holds OS ownership while the process is alive and releases it on close",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"immich-db-owner-"));
  const vault=new Vault(directory,randomBytes(32),"test");
  let closed=false;
  const code="const {DatabaseSync}=require('node:sqlite');let db;try{db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=50; SELECT count(*) FROM records;');process.stdout.write('opened');}catch(e){if(/locked|busy/i.test(e.message))process.stdout.write('locked');else throw e;}finally{db?.close();}";
  try{
    assert.equal((vault.db.prepare("PRAGMA locking_mode").get() as any).locking_mode,"exclusive");
    const second=spawnSync(process.execPath,["-e",code,join(directory,"vault.sqlite")],{encoding:"utf8",timeout:10000});
    assert.equal(second.status,0);assert.equal(second.stdout,"locked");
    vault.close();closed=true;
    const reopened=spawnSync(process.execPath,["-e",code,join(directory,"vault.sqlite")],{encoding:"utf8",timeout:10000});
    assert.equal(reopened.status,0);assert.equal(reopened.stdout,"opened");
  }finally{if(!closed)vault.close();await rm(directory,{recursive:true,force:true});}
});
