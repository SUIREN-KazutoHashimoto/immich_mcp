import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,copyFile,mkdir,writeFile,readFile,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Vault } from "../src/vault.js";

const source=(bytes:Uint8Array)=>(async function*(){yield bytes;})();
async function fixture(run:(directory:string,key:Buffer)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"immich-store-identity-"));
  try{await run(directory,randomBytes(32));}finally{await rm(directory,{recursive:true,force:true});}
}
test("a different database cannot claim a previously used storage directory after shutdown",()=>fixture(async(dir,key)=>{
  let vault:Vault|undefined=new Vault(dir,key,"test");
  try{
    const bytes=Buffer.from("PRESERVE-ORIGINAL-OBJECT"),raw=await vault.capture("A",source(bytes),1024);
    const objectPath=join(dir,"objects",raw.raw_ref),encrypted=await readFile(objectPath);
    vault.close();vault=undefined;
    const other=join(dir,"wrong.sqlite");
    for(let attempt=0;attempt<2;attempt++){
      assert.throws(()=>new Vault(dir,key,"test",other),{code:"store_identity_mismatch"});
      assert.deepEqual(await readFile(objectPath),encrypted);
    }
    const wrong=new DatabaseSync(other);
    try{assert.equal(wrong.prepare("SELECT COUNT(*) n FROM records").get()!.n,0);}finally{wrong.close();}
    vault=new Vault(dir,key,"test");
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
  }finally{vault?.close();}
}));
test("moving a cleanly closed database preserves its authenticated storage identity",()=>fixture(async(dir,key)=>{
  let vault:Vault|undefined=new Vault(dir,key,"test");
  try{
    const bytes=Buffer.from("relocated database"),raw=await vault.capture("A",source(bytes),1024);
    const identity=vault.get("__system","store_identity","store_identity");
    vault.close();vault=undefined;
    const moved=join(dir,"relocated.sqlite");await copyFile(join(dir,"vault.sqlite"),moved);
    vault=new Vault(dir,key,"test",moved);
    assert.deepEqual(vault.get("__system","store_identity","store_identity"),identity);
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
  }finally{vault?.close();}
}));
test("a pre-identity vault migrates using its verified master-key check and preserves existing objects",()=>fixture(async(dir,key)=>{
  let vault:Vault|undefined=new Vault(dir,key,"test");
  try{
    const bytes=Buffer.from("legacy encrypted original"),raw=await vault.capture("A",source(bytes),1024);
    vault.db.exec("DELETE FROM records WHERE principal='__system' AND id='store_identity'");
    (vault as any).owner.exec("DELETE FROM owner_identity");
    vault.close();vault=undefined;
    assert.throws(()=>new Vault(dir,randomBytes(32),"test"));
    vault=new Vault(dir,key,"test");
    assert.ok(vault.get("__system","store_identity","store_identity").id);
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
    const bound=(vault as any).owner.prepare("SELECT store_id FROM owner_identity").get();
    assert.equal(bound.store_id,vault.get("__system","store_identity","store_identity").id);
  }finally{vault?.close();}
}));
test("a fresh database refuses unbound existing objects on every retry without minting a key check",()=>fixture(async(dir,key)=>{
  const objects=join(dir,"objects"),name="raw_"+randomUUID(),bytes=Buffer.from("unknown original must survive");
  await mkdir(objects);await writeFile(join(objects,name),bytes);
  for(let attempt=0;attempt<2;attempt++){
    assert.throws(()=>new Vault(dir,key,"test"),{code:"store_identity_mismatch"});
    assert.deepEqual(await readFile(join(objects,name)),bytes);
    const database=new DatabaseSync(join(dir,"vault.sqlite"));
    try{assert.equal(database.prepare("SELECT COUNT(*) n FROM records").get()!.n,0);}finally{database.close();}
  }
}));
test("startup can finish an interrupted owner binding using the existing authenticated database identity",()=>fixture(async(dir,key)=>{
  let vault:Vault|undefined=new Vault(dir,key,"test");
  try{
    const before=vault.get("__system","store_identity","store_identity");
    (vault as any).owner.exec("DELETE FROM owner_identity");
    vault.close();vault=undefined;
    vault=new Vault(dir,key,"test");
    assert.deepEqual(vault.get("__system","store_identity","store_identity"),before);
    assert.equal((vault as any).owner.prepare("SELECT store_id FROM owner_identity").get().store_id,before.id);
  }finally{vault?.close();}
}));
test("an already initialized unrelated database is rejected even when it uses the same master key",()=>fixture(async(dir,key)=>{
  const first=join(dir,"first"),second=join(dir,"second");await mkdir(first);await mkdir(second);
  let vault:Vault|undefined=new Vault(first,key,"test"),other:Vault|undefined=new Vault(second,key,"test");
  try{
    const bytes=Buffer.from("first-store"),raw=await vault.capture("A",source(bytes),1024);
    const original=await readFile(join(first,"objects",raw.raw_ref));
    vault.close();vault=undefined;other.close();other=undefined;
    assert.throws(()=>new Vault(first,key,"test",join(second,"vault.sqlite")),{code:"store_identity_mismatch"});
    assert.deepEqual(await readFile(join(first,"objects",raw.raw_ref)),original);
    vault=new Vault(first,key,"test");other=new Vault(second,key,"test");
    assert.deepEqual(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()),bytes);
  }finally{vault?.close();other?.close();}
}));

test("an unbound legacy root refuses unknown originals even with a valid reusable master-key check",()=>fixture(async(dir,key)=>{
  let vault:Vault|undefined=new Vault(dir,key,"test");
  try{
    const raw=await vault.capture("A",source(Buffer.from("owned original")),1024),path=join(dir,"objects",raw.raw_ref),original=await readFile(path);
    vault.db.exec("DELETE FROM records WHERE principal='__system' AND id='store_identity'");
    (vault as any).owner.exec("DELETE FROM owner_identity");vault.close();vault=undefined;
    const unknown=join(dir,"objects","raw_"+randomUUID());await writeFile(unknown,"KEEP-UNKNOWN-ORIGINAL");
    for(let attempt=0;attempt<2;attempt++)assert.throws(()=>new Vault(dir,key,"test"),{code:"store_identity_mismatch"});
    assert.deepEqual(await readFile(path),original);assert.equal(await readFile(unknown,"utf8"),"KEEP-UNKNOWN-ORIGINAL");
    const database=new DatabaseSync(join(dir,"vault.sqlite"));
    try{assert.equal(database.prepare("SELECT 1 FROM records WHERE principal='__system' AND id='store_identity'").get(),undefined);}finally{database.close();}
    await unlink(unknown);vault=new Vault(dir,key,"test");
    assert.equal(Buffer.from(await new Response(vault.rawStream("A",raw.raw_ref) as any).arrayBuffer()).toString(),"owned original");
    const identity=vault.get("__system","store_identity","store_identity");
    (vault as any).owner.exec("DELETE FROM owner_identity");vault.close();vault=undefined;
    await writeFile(unknown,"KEEP-UNKNOWN-ORIGINAL");
    assert.throws(()=>new Vault(dir,key,"test"),{code:"store_identity_mismatch"});
    assert.deepEqual(await readFile(path),original);assert.equal(await readFile(unknown,"utf8"),"KEEP-UNKNOWN-ORIGINAL");
    await unlink(unknown);vault=new Vault(dir,key,"test");
    assert.deepEqual(vault.get("__system","store_identity","store_identity"),identity);
  }finally{vault?.close();}
}));
