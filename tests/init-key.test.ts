import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMasterKey } from "../scripts/init-key.js";
test("explicit master-key creation uses random raw bytes and never overwrites an existing file",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"immich-key-"));
  try{
    const path=join(dir,"master.key");await createMasterKey(path);const original=await readFile(path);
    assert.equal(original.length,32);
    await assert.rejects(createMasterKey(path),{code:"EEXIST"});assert.deepEqual(await readFile(path),original);
    const other=join(dir,"other.key");await createMasterKey(other);assert.notDeepEqual(await readFile(other),original);
    if(process.platform!=="win32")assert.equal((await stat(path)).mode&0o077,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("master-key creation requires an explicit absolute destination",async()=>{
  await assert.rejects(createMasterKey(""));await assert.rejects(createMasterKey("relative-master.key"));
});
