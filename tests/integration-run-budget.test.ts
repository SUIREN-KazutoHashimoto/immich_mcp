import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { upLab } from "../src/integration-lab.js";
import { withInitializedFixtureLab } from "../src/integration-bootstrap.js";
import { IntegrationRun,type CaseSpec } from "../src/integration-run.js";
import { BridgeError } from "../src/types.js";
import { setup,fakeDocker } from "./lab-harness.js";
import { mediaBackend,seedHarnessAccounts } from "./media-harness.js";

const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const spec=(id:string):CaseSpec=>({id,actor:"admin",call:{operation_id:"getServerVersion"},status:200,kind:"success",mutates:false,assertions:["version"]});
const verify=(result:any,check:(ok:unknown,id:string)=>void)=>check(result.data.major===3&&result.data.minor===3&&result.data.patch===5,"version");
async function environment(){
  const {base,root}=await setup(),{runner}=fakeDocker(root),{backend,http}=mediaBackend();
  await upLab(root,{docker:runner,http});await seedHarnessAccounts(root,backend);
  return {base,root,runner,backend,http};
}
test("a bounded feature plan persists its limit and refuses overflow or changed revalidation limits before dispatch",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async ctx=>{
      const run=new IntegrationRun(ctx,"small_budget_v1",{maxCases:2});
      await run.execute(spec("first"),verify);await run.execute(spec("second"),verify);
      assert.equal(run.state.case_limit,2);
      const before=backend.calls.length;
      await assert.rejects(run.execute(spec("third"),verify),isCode("fixture_case"));
      assert.equal(backend.calls.length,before);assert.equal(run.state.cases.length,2);
      run.finish();
      for(const limit of [undefined,1,3,384])assert.throws(()=>new IntegrationRun(ctx,"small_budget_v1",limit===undefined?{}:{maxCases:limit}),isCode("fixture_plan"));
      assert.equal(backend.calls.length,before);
      const again=new IntegrationRun(ctx,"small_budget_v1",{maxCases:2});
      assert.equal(again.revalidate,true);
      await again.execute(spec("first"),verify);await again.execute(spec("second"),verify);again.finish();
      assert.equal(again.state.validation?.state,"completed");
      assert.equal(again.state.cases.length,2);assert.equal(again.state.validation?.cases.length,2);
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});
test("invalid feature budgets do not create journal evidence or dispatch a request",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async ctx=>{
      const before=backend.calls.length;
      for(const limit of [0,-1,513,Infinity,NaN,1.5,"384",null]){
        assert.throws(()=>new IntegrationRun(ctx,"invalid_budget_v1",{maxCases:limit as any}),isCode("fixture_plan"));
        assert.equal(ctx.vault.db.prepare("SELECT count(*) AS n FROM records WHERE principal=? AND id=? AND kind='fixture_run'").get("__integration_feature_runs","invalid_budget_v1")!.n,0);
      }
      assert.equal(backend.calls.length,before);
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});
test("legacy default-budget evidence remains compatible and expanded plans keep the same mutation fence",async()=>{
  const {base,root,runner,backend,http}=await environment();
  try{
    await withInitializedFixtureLab(root,async ctx=>{
      const legacy=new IntegrationRun(ctx,"legacy_budget_v1");
      await legacy.execute(spec("version"),verify);legacy.finish();
      assert.equal(Object.hasOwn(legacy.state,"case_limit"),false);
      const again=new IntegrationRun(ctx,"legacy_budget_v1",{maxCases:256});
      await again.execute(spec("version"),verify);again.finish();
      const expanded=new IntegrationRun(ctx,"expanded_budget_v1",{maxCases:384});
      const before=backend.calls.length;
      assert.equal(expanded.state.case_limit,384);
      assert.throws(()=>new IntegrationRun(ctx,"expanded_budget_v1",{maxCases:384}),isCode("fixture_recovery_required"));
      expanded.fail(new BridgeError("fixture_outcome_unknown","synthetic lost acknowledgement"));
      assert.throws(()=>new IntegrationRun(ctx,"expanded_budget_v1",{maxCases:384}),isCode("fixture_recovery_required"));
      assert.equal(backend.calls.length,before);
    },{docker:runner,http});
  }finally{await rm(base,{recursive:true,force:true});}
});
