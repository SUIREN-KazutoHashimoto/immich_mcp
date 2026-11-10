import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixtureStoredZip } from "../src/integration-zip.js";
const oracle=JSON.parse(await readFile(new URL("./stored-zip-oracle.json",import.meta.url),"utf8"));
const bytes=()=>Buffer.from(oracle.base64,"base64");
test("the bounded archive reader accepts an independent Python ZIP STORE oracle with UTF-8 names and streaming descriptors",()=>{
  assert.equal(createHash("sha256").update(bytes()).digest("hex"),oracle.sha256);
  const entries=fixtureStoredZip(bytes());assert.equal(entries.length,oracle.entries.length);
  for(let i=0;i<entries.length;i++){assert.equal(entries[i]!.name,oracle.entries[i].name);assert.equal(entries[i]!.bytes.toString("base64"),oracle.entries[i].base64);assert.equal(entries[i]!.crc32,oracle.entries[i].crc32);}
});
test("corrupt payloads, truncation, encrypted/deflated entries and overlapping or traversal names cannot pass archive validation",()=>{
  const original=bytes(),end=original.length-22,central=original.readUInt32LE(end+16);
  const changes=[
    (b:Buffer)=>{const p=b.readUInt16LE(26)+30;b.writeUInt8(b.readUInt8(p)^1,p);},
    (b:Buffer)=>{b.writeUInt16LE(b.readUInt16LE(central+8)|1,central+8);},
    (b:Buffer)=>{b.writeUInt16LE(8,central+10);},
    (b:Buffer)=>{b.writeUInt32LE(1,central+42);},
    (b:Buffer)=>{b[central+46]=47;b[30]=47;},
    (b:Buffer)=>{b.writeUInt32LE(0xffffffff,end+16);},
    (b:Buffer)=>{b.writeUInt16LE(33,end+10);},
    (b:Buffer)=>{b.writeUInt32LE(0xffffffff,central+24);}
  ];
  for(const change of changes){const b=Buffer.from(original);change(b);assert.throws(()=>fixtureStoredZip(b),{code:"fixture_zip_shape"});}
  assert.throws(()=>fixtureStoredZip(original.subarray(0,-1)),{code:"fixture_zip_shape"});
  assert.throws(()=>fixtureStoredZip(Buffer.alloc(2*1024*1024+1)),{code:"fixture_zip_shape"});
});
