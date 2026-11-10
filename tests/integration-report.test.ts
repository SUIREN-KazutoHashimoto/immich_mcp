import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,rmdir,rm,readFile } from "node:fs/promises";
import { join } from "node:path";
import { setup,fakeDocker,state } from "./lab-harness.js";
import { mediaBackend,seedHarnessAccounts } from "./media-harness.js";
import { upLab } from "../src/integration-lab.js";
import { bootstrapLab,withInitializedFixtureLab,fixtureServerId } from "../src/integration-bootstrap.js";
import { IntegrationRun,type CaseSpec } from "../src/integration-run.js";
import { BridgeError } from "../src/types.js";
import { Vault } from "../src/vault.js";
const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;

test("a failed bootstrap report publication preserves committed accounts and only revalidates on retry",async()=>{
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,http}=mediaBackend();
  await upLab(root,{docker:runner,http});const path=join(root,"bootstrap-report.json");await mkdir(path);
  try{
    let caught:unknown;await assert.rejects(bootstrapLab(root,{docker:runner,http}),error=>{caught=error;return true;});
    const s=await state(root),key=await readFile(join(root,".vault.key")),vault=new Vault(join(root,"fixtures"),key,fixtureServerId(s));key.fill(0);
    try{assert.equal(vault.get("__integration_fixture_bootstrap","bootstrap","fixture_bootstrap").state,"completed");}finally{vault.close();}
    assert.ok(isCode("fixture_report_failed")(caught));assert.equal(backend.users.length,3);assert.equal(backend.keys.length,4);
    await rmdir(path);backend.calls.length=0;
    assert.equal((await bootstrapLab(root,{docker:runner,http})).state,"already_initialized");
    assert.equal(backend.calls.filter(c=>c.method==="POST").length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("completed scenario evidence survives report failure and closes requests while allowing read-only revalidation",async()=>{
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,http}=mediaBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);
  try{
    await withInitializedFixtureLab(root,async context=>{
      const spec:CaseSpec={id:"version",actor:"admin",call:{operation_id:"getServerVersion"},kind:"success",status:200,mutates:false,assertions:["major","patch"]};
      const verify=(result:any,check:(condition:unknown,id:string)=>void)=>{check(result.data.patch===5,"patch");check(result.data.major===3,"major");};
      const run=new IntegrationRun(context,"report_commit_v1");await run.execute(spec,verify);run.finish();
      const path=join(root,"report_commit_v1.report.json");await mkdir(path);
      let publicationError:unknown;
      await assert.rejects(run.publish(),error=>{publicationError=error;run.fail(error);return true;});
      assert.equal(run.state.state,"completed");assert.ok(isCode("fixture_report_failed")(publicationError));assert.equal(run.completionCommitted,true);
      const count=backend.calls.length;
      await assert.rejects(run.execute({...spec,id:"late_request"},verify),isCode("fixture_run_closed"));assert.equal(backend.calls.length,count);
      await rmdir(path);
      const next=new IntegrationRun(context,"report_commit_v1");assert.equal(next.revalidate,true);
      await next.execute(spec,verify);next.finish();await next.publish();assert.equal(next.state.validation?.state,"completed");
      assert.equal(backend.calls.filter(c=>c.method==="POST").length,0);
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});
