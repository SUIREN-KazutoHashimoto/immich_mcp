import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes,randomUUID,createCipheriv,createHash } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,rm,copyFile,unlink,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
const server="legacy-test",plain=Buffer.from("LEGACY-ORIGINAL-\u96ea");
async function fixture(run:(dir:string,key:Buffer)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-vault-migrate-"));
  try{await run(dir,randomBytes(32));}finally{await rm(dir,{recursive:true,force:true});}
}
function legacyCipher(key:Buffer,p:string,id:string,kind:string,value:any){
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([1,server,p,id,kind])));
  const body=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),body]);
}
async function legacy(dir:string,key:Buffer,bad=false){
  const db=new DatabaseSync(join(dir,"vault.sqlite")),raw="raw_"+randomUUID(),storeId=randomUUID(),nonce=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(Buffer.from(JSON.stringify([1,server,"A",raw,"raw"])));
  const bytes=Buffer.concat([cipher.update(plain),cipher.final()]);await mkdir(join(dir,"objects"));await writeFile(join(dir,"objects",raw),bytes);
  db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(1);"+
    "CREATE TABLE records(principal TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,payload BLOB NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,id));"+
    "CREATE TABLE bindings(principal TEXT PRIMARY KEY,revision INTEGER NOT NULL,credential TEXT,key_id TEXT,state TEXT NOT NULL);");
  const put=(p:string,id:string,kind:string,value:any)=>{
    const payload=legacyCipher(key,p,id,kind,value);db.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(p,id,kind,payload,Number.MAX_SAFE_INTEGER);return payload;
  };
  put("__system","key_check","check",{ok:true});put("__system","store_identity","store_identity",{id:storeId});
  put("A","credential-legacy","credential",{key:"LEGACY-KEY-CANARY",revision:3});
  db.prepare("INSERT INTO bindings VALUES(?,?,?,?,?)").run("A",3,"credential-legacy","legacy-key-id","active");
  const before=put("A","secret-legacy","secret",{value:"LEGACY-SECRET-CANARY"});
  put("A",raw,"raw",{nonce:nonce.toString("hex"),tag:cipher.getAuthTag().toString("hex"),size:plain.length,sha256:createHash("sha256").update(plain).digest("hex"),transfer_complete:true});
  const damaged=put("B","late-secret","secret",{value:"LATE-CANARY"});if(bad){damaged[damaged.length-1]=damaged[damaged.length-1]!^1;db.prepare("UPDATE records SET payload=? WHERE principal='B'").run(damaged);}
  db.close();return {raw,storeId,before,bytes};
}
test("legacy records migrate atomically while their original files keep the old authenticated format",()=>fixture(async(dir,key)=>{
  const old=await legacy(dir,key),v=new Vault(dir,key,server);
  try{
    assert.equal(v.schemaVersion,2);assert.match(v.keyVersion,/^[a-f0-9-]{36}$/);
    assert.equal(v.credential("A").key,"LEGACY-KEY-CANARY");assert.equal(v.credential("A").revision,3);
    assert.equal(v.get("A","secret-legacy","secret").value,"LEGACY-SECRET-CANARY");
    const metadata=v.get("A",old.raw,"raw");assert.deepEqual(metadata.crypto,{format:1,key_version:v.keyVersion});
    assert.deepEqual(Buffer.from(await new Response(v.rawStream("A",old.raw) as any).arrayBuffer()),plain);
    assert.deepEqual(await readFile(join(dir,"objects",old.raw)),old.bytes);
    assert.equal(v.db.prepare("SELECT COUNT(*) n FROM records WHERE key_version<>?").get(v.keyVersion)!.n,0);
    assert.ok(!Buffer.from((v.db.prepare("SELECT payload FROM records WHERE id='secret-legacy'").get() as any).payload).includes(Buffer.from("LEGACY-SECRET-CANARY")));
  }finally{v.close();}
}));
test("a late authentication failure rolls back every metadata rewrite and schema change",()=>fixture(async(dir,key)=>{
  const old=await legacy(dir,key,true);assert.throws(()=>new Vault(dir,key,server));
  const db=new DatabaseSync(join(dir,"vault.sqlite"));
  try{
    assert.equal(db.prepare("SELECT version FROM schema_version").get()!.version,1);
    assert.ok(!(db.prepare("PRAGMA table_info(records)").all() as any[]).some(c=>c.name==="key_version"));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='vault_crypto'").get(),undefined);
    assert.deepEqual(Buffer.from((db.prepare("SELECT payload FROM records WHERE id='secret-legacy'").get() as any).payload),old.before);
    db.prepare("UPDATE records SET payload=? WHERE principal='B'").run(legacyCipher(key,"B","late-secret","secret",{value:"REPAIRED"}));
  }finally{db.close();}
  const v=new Vault(dir,key,server);try{assert.equal(v.get("B","late-secret","secret").value,"REPAIRED");}finally{v.close();}
  assert.deepEqual(await readFile(join(dir,"objects",old.raw)),old.bytes);
}));
test("unknown main and owner schema versions are rejected without normalizing their version rows",()=>fixture(async(dir,key)=>{
  await legacy(dir,key);
  let db=new DatabaseSync(join(dir,"vault.sqlite"));db.exec("UPDATE schema_version SET version=99");db.close();
  assert.throws(()=>new Vault(dir,key,server),/Unsupported schema_version/);
  db=new DatabaseSync(join(dir,"vault.sqlite"));assert.equal(db.prepare("SELECT version FROM schema_version").get()!.version,99);db.exec("UPDATE schema_version SET version=1");db.close();
  const owner=new DatabaseSync(join(dir,".storage-owner.sqlite"));owner.exec("UPDATE ownership SET version=99");owner.close();
  assert.throws(()=>new Vault(dir,key,server),/Unsupported ownership/);
  const again=new DatabaseSync(join(dir,".storage-owner.sqlite"));try{assert.deepEqual(again.prepare("SELECT version FROM ownership").all().map(r=>r.version),[99]);}finally{again.close();}
}));
test("key-version changes are authenticated rather than accepted as editable metadata",()=>fixture(async(dir,key)=>{
  let v:Vault|undefined=new Vault(dir,key,server);let version="";
  try{
    version=v.keyVersion;v.put("A","secret",{value:"VERSION-CANARY"},undefined,"secret");
    v.db.prepare("UPDATE records SET key_version=? WHERE id='secret'").run(randomUUID());
    assert.throws(()=>v!.get("A","secret","secret"),{code:"key_version_mismatch"});
    const replacement=randomUUID();v.db.prepare("UPDATE records SET key_version=?").run(replacement);v.db.prepare("UPDATE vault_crypto SET key_version=?").run(replacement);
    v.close();v=undefined;assert.throws(()=>new Vault(dir,key,server));
    const db=new DatabaseSync(join(dir,"vault.sqlite"));db.prepare("UPDATE records SET key_version=?").run(version);db.prepare("UPDATE vault_crypto SET key_version=?").run(version);db.close();
    v=new Vault(dir,key,server);assert.equal(v.get("A","secret","secret").value,"VERSION-CANARY");
  }finally{v?.close();}
}));
test("wrong keys cannot trigger legacy migration or alter existing ciphertext",()=>fixture(async(dir,key)=>{
  const old=await legacy(dir,key);assert.throws(()=>new Vault(dir,randomBytes(32),server));
  const db=new DatabaseSync(join(dir,"vault.sqlite"));try{
    assert.equal(db.prepare("SELECT version FROM schema_version").get()!.version,1);
    assert.deepEqual(Buffer.from((db.prepare("SELECT payload FROM records WHERE id='secret-legacy'").get() as any).payload),old.before);
  }finally{db.close();}
  assert.deepEqual(await readFile(join(dir,"objects",old.raw)),old.bytes);
}));
test("incomplete and backup-only stores cannot start as an application",()=>fixture(async(dir,key)=>{
  for(const flag of [".maintenance-incomplete",".backup-only"]){
    const root=join(dir,flag.slice(1));await mkdir(root);await writeFile(join(root,flag),"not activated");
    assert.throws(()=>new Vault(root,key,server),{code:"maintenance_incomplete"});await assert.rejects(stat(join(root,"vault.sqlite")),{code:"ENOENT"});
    const staged=new Vault(root,key,server,undefined,{},true);staged.close();
    assert.throws(()=>new Vault(root,key,server),{code:"maintenance_incomplete"});await unlink(join(root,flag));
    const active=new Vault(root,key,server);try{assert.equal(active.schemaVersion,2);assert.throws(()=>active.readStored("__system","key_check","check"),{code:"maintenance_required"});}finally{active.close();}
  }
}));
test("exclusive offline SQLite snapshots preserve schema, key version and owner binding",()=>fixture(async(dir,key)=>{
  const old=await legacy(dir,key),source=new Vault(dir,key,server,undefined,{},true),target=join(dir,"snapshot");await mkdir(target);
  try{
    await source.snapshotDatabases(join(target,"vault.sqlite"),join(target,".storage-owner.sqlite"));await mkdir(join(target,"objects"));await copyFile(join(dir,"objects",old.raw),join(target,"objects",old.raw));
    const restored=new Vault(target,key,server);
    try{assert.equal(restored.keyVersion,source.keyVersion);assert.equal(restored.get("A","secret-legacy","secret").value,"LEGACY-SECRET-CANARY");
      assert.deepEqual(Buffer.from(await new Response(restored.rawStream("A",old.raw) as any).arrayBuffer()),plain);
    }finally{restored.close();}
  }finally{source.close();}
}));
