import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decryptRecord,encryptRecord,validVersion,type CryptoFormat } from "./vault-crypto.js";

export interface VaultSchema {version:1|2;format:CryptoFormat;keyVersion:string;}
const table=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const singleVersion=(db:DatabaseSync,name:string,supported:number[])=>{
  const rows=db.prepare("SELECT version FROM "+name).all() as {version:number}[];
  if(rows.length!==1||!supported.includes(rows[0]!.version))throw Error("Unsupported "+name);
  return rows[0]!.version;
};
export function openStorageOwner(directory:string){
  const db=new DatabaseSync(join(directory,".storage-owner.sqlite"));
  try{
    db.exec("PRAGMA busy_timeout=1000;PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE;");
    if(table(db,"ownership"))singleVersion(db,"ownership",[1]);
    else{
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get())throw Error("Unrecognized storage-owner database");
      db.exec("CREATE TABLE ownership(version INTEGER PRIMARY KEY);INSERT INTO ownership VALUES(1);");
    }
    db.exec("CREATE TABLE IF NOT EXISTS owner_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL);COMMIT;");
    return db;
  }catch(error){if(db.isTransaction)db.exec("ROLLBACK");db.close();throw error;}
}
export function readVaultSchema(db:DatabaseSync,create=true):VaultSchema{
  if(!table(db,"schema_version")){
    if(!create)throw Error("Vault schema is missing");
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get())throw Error("Unrecognized vault schema");
    db.exec("BEGIN IMMEDIATE;CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(1);"+
      "CREATE TABLE records(principal TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,payload BLOB NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(principal,id));"+
      "CREATE TABLE bindings(principal TEXT PRIMARY KEY,revision INTEGER NOT NULL,credential TEXT,key_id TEXT,state TEXT NOT NULL);COMMIT;");
  }
  const version=singleVersion(db,"schema_version",[1,2]) as 1|2;
  if(!table(db,"records")||!table(db,"bindings"))throw Error("Incomplete vault schema");
  const columns=db.prepare("PRAGMA table_info(records)").all() as {name:string}[];
  if(version===1){if(columns.some(c=>c.name==="key_version")||table(db,"vault_crypto"))throw Error("Conflicting legacy vault schema");return {version:1,format:1,keyVersion:"legacy"};}
  if(!columns.some(c=>c.name==="key_version")||!table(db,"vault_crypto"))throw Error("Incomplete versioned vault schema");
  const rows=db.prepare("SELECT singleton,format,key_version FROM vault_crypto").all() as {singleton:number;format:number;key_version:string}[];
  if(rows.length!==1||rows[0]!.singleton!==1||rows[0]!.format!==2||!validVersion(rows[0]!.key_version))throw Error("Invalid vault crypto metadata");
  const keyVersion=rows[0]!.key_version;
  if(db.prepare("SELECT 1 FROM records WHERE key_version IS NULL OR key_version<>? LIMIT 1").get(keyVersion))throw Error("Mixed or unknown key versions");
  return {version:2,format:2,keyVersion};
}
export function migrateVault(db:DatabaseSync,key:Buffer,serverId:string,schema:VaultSchema):VaultSchema{
  if(schema.version===2)return schema;
  const keyVersion=randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try{
    db.exec("ALTER TABLE records ADD COLUMN key_version TEXT NOT NULL DEFAULT 'legacy';"+
      "CREATE TABLE vault_crypto(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,key_version TEXT NOT NULL);");
    const update=db.prepare("UPDATE records SET payload=?,key_version=? WHERE principal=? AND id=?");
    for(const row of db.prepare("SELECT principal,id,kind,payload FROM records ORDER BY rowid").iterate() as Iterable<{principal:string;id:string;kind:string;payload:Uint8Array}>){
      const value=decryptRecord(key,1,"legacy",serverId,row.principal,row.id,row.kind,row.payload);
      if(row.kind==="raw")value.crypto={format:1,key_version:keyVersion};
      const payload=encryptRecord(key,2,keyVersion,serverId,row.principal,row.id,row.kind,value);
      update.run(payload,keyVersion,row.principal,row.id);
    }
    db.prepare("INSERT INTO vault_crypto VALUES(1,2,?)").run(keyVersion);
    db.exec("UPDATE schema_version SET version=2 WHERE version=1;COMMIT;");
    return {version:2,format:2,keyVersion};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
