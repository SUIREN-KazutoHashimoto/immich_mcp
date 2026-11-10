import { isDeepStrictEqual } from "node:util";
import { randomBytes,randomUUID } from "node:crypto";
import { writeFile,rename } from "node:fs/promises";
import { join } from "node:path";
import { AccessAuth } from "./access.js";
import { Control } from "./control.js";
import { Contexts } from "./contexts.js";
import { Staging } from "./staging.js";
import { DownloadPolicy } from "./download.js";
import { operation,registry } from "./registry.js";
import { syncDirectory } from "./vault-rekey.js";
import type { InitializedFixtureLab,FixtureRole } from "./integration-bootstrap.js";
import { BridgeError,type ApiCall } from "./types.js";

const CONTROL="__integration_feature_runs",FOREVER=Number.MAX_SAFE_INTEGER;
export type CaseKind="success"|"refusal"|"local_refusal";
export interface CaseContext {ref:string;generation:number;}
export interface CaseSpec {
  id:string;actor:FixtureRole;call:ApiCall;status:number|null;kind:CaseKind;mutates:boolean;assertions:string[];
  context?:CaseContext;expected_error?:string;result_view?:"complete_jsonl";
}
export interface CaseReceipt {
  id:string;actor:FixtureRole;operation_id:string;method:string;path:string;expected_status:number|null;status:number|null;kind:CaseKind;mutates:boolean;
  state:"prepared"|"sent"|"passed"|"failed"|"outcome_unknown";assertions:string[];input:ApiCall;created_at:string;sent_at?:string;completed_at?:string;result_ref?:string;diagnostic_code?:string;
  context?:CaseContext;auth_route?:"api_key"|"explicit_context";auth_context_kind?:string;expected_error?:string;result_view?:"complete_jsonl";
}
interface Validation {state:"started"|"completed"|"failed";cases:CaseReceipt[];started_at:string;completed_at?:string;diagnostic_code?:string;}
export interface FeatureRunState {
  version:1;run_id:string;plan:string;openapi_sha256:string;execution_scope:InitializedFixtureLab["executionScope"];
  state:"started"|"completed"|"recovery_required";case_limit?:number;created_at:string;updated_at:string;completed_at?:string;
  data:Record<string,any>;cases:CaseReceipt[];validation?:Validation;diagnostic_code?:string;
}
export const integrationFailure=(code:string,message:string):never=>{throw new BridgeError(code,message);};
const diagnostic=(error:unknown)=>error instanceof BridgeError&&/^[a-z][a-z0-9_]{1,63}$/.test(error.code)?error.code:"fixture_scenario_failed";
export class IntegrationRun {
  readonly state:FeatureRunState;
  readonly revalidate:boolean;
  readonly staging:Staging;
  readonly contexts:Contexts;
  private control:Control;
  private readonly caseLimit:number;
  private completedCommit=false;
  get completionCommitted(){return this.completedCommit;}
  constructor(readonly context:InitializedFixtureLab,readonly plan:string,options:{maxCases?:number}={}){
    const limit=options.maxCases===undefined?256:options.maxCases;
    if(!Number.isSafeInteger(limit)||limit<1||limit>512)integrationFailure("fixture_plan","Feature-case limit must be an integer from 1 through 512");
    this.caseLimit=limit;
    if(!/^[a-z][a-z0-9_]{1,63}$/.test(plan))integrationFailure("fixture_plan","Invalid feature-plan identity");
    const {vault,lab}=context,row=vault.db.prepare("SELECT id FROM records WHERE principal=? AND id=? AND kind='fixture_run'").get(CONTROL,plan);
    const prior:FeatureRunState|undefined=row?vault.get(CONTROL,plan,"fixture_run"):undefined;
    if(prior&&(prior.version!==1||prior.run_id!==lab.state.id||prior.plan!==plan||prior.openapi_sha256!==registry.sha256))integrationFailure("fixture_plan","Feature evidence belongs to a different plan or run");
    if(prior&&(prior.case_limit??256)!==limit)integrationFailure("fixture_plan","Feature-case limit differs from the authenticated original plan");
    if(prior&&prior.state!=="completed")integrationFailure("fixture_recovery_required","A previous feature run may have changed data; do not replay its mutations");
    const now=new Date().toISOString();this.revalidate=!!prior;
    this.state=prior ?? {version:1,run_id:lab.state.id,plan,openapi_sha256:registry.sha256,execution_scope:context.executionScope,state:"started",
      created_at:now,updated_at:now,data:{},cases:[],...(limit===256?{}:{case_limit:limit})};
    if(context.executionScope==="harness_only")this.state.execution_scope="harness_only";
    if(prior)this.state.validation={state:"started",cases:[],started_at:now};
    this.save();
    this.staging=new Staging(vault,new DownloadPolicy([]),{maxFileBytes:1024*1024,ttlMs:86400000});
    const origin="https://integration.invalid",access=new AccessAuth({issuer:origin,audience:"isolated-integration",jwksUrl:origin+"/cdn-cgi/access/certs",publicOrigin:origin});
    this.contexts=new Contexts(vault,context.executor,origin);
    const csrf=randomBytes(32);try{this.control=new Control(access,vault,context.executor,csrf,this.staging,undefined,undefined,this.contexts);}finally{csrf.fill(0);}
  }
  private current(){return this.revalidate?this.state.validation!.cases:this.state.cases;}
  save(){this.state.updated_at=new Date().toISOString();this.context.vault.put(CONTROL,"fixture_run",this.state,FOREVER,this.plan);}
  protect(actor:FixtureRole,call:ApiCall,values:Record<string,string>,context?:CaseContext):ApiCall {
    if(this.revalidate||this.completedCommit)integrationFailure("fixture_replay","Protected inputs may only be created during initial fixture setup");
    const principal=this.context.actors[actor].principal,input=structuredClone(call);
    const selected=context?this.contexts.check(principal,context.ref,context.generation):undefined;
    for(const [pointer,value] of Object.entries(values)){
      if(!/^\/[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/.test(pointer)||pointer.length>256||typeof value!=="string"||value.length>65536||
        !registry.secretRules.flatMap(rule=>rule.bindings).some(rule=>rule.operation_id===call.operation_id&&rule.direction==="request"&&rule.instance_pointer_pattern===pointer))
        integrationFailure("fixture_secret","Expected a declared protected input");
      input.body ??= {};
      const tokens=pointer.slice(1).split("/"),last=tokens.pop()!;let parent=input.body;
      for(const token of tokens){
        if(!parent||typeof parent!=="object"||Array.isArray(parent)||!Object.hasOwn(parent,token))integrationFailure("fixture_secret","Protected input parent is missing");
        parent=parent[token];
      }
      if(!parent||typeof parent!=="object"||Array.isArray(parent)||Object.hasOwn(parent,last)||input.secret_bindings?.some(binding=>binding.location==="body"&&binding.pointer===pointer))
        integrationFailure("fixture_secret","Protected input was already supplied");
      const ref=this.context.vault.put(principal,"secret",{value,revision:this.context.vault.resourceRevision(principal),operation_id:call.operation_id,location:"body",pointer,
        ...(selected?{context_ref:context!.ref,context_generation:selected.generation}:{})},FOREVER);
      (input.secret_bindings ??= []).push({location:"body",pointer,secret_ref:ref});
    }
    return input;
  }
  async execute(spec:CaseSpec,verify:(result:any,check:(condition:unknown,id:string)=>void)=>void|Promise<void>){
    if(this.completedCommit)integrationFailure("fixture_run_closed","No requests may be added after completion is committed");
    if(typeof spec.mutates!=="boolean"||!Object.hasOwn(this.context.actors,spec.actor)||!["success","refusal","local_refusal"].includes(spec.kind)||!/^[a-z][a-z0-9_]{1,79}$/.test(spec.id)||!Array.isArray(spec.assertions)||!spec.assertions.length||new Set(spec.assertions).size!==spec.assertions.length||
      spec.assertions.some(id=>!/^[a-z][a-z0-9_]{1,63}$/.test(id))||
      (spec.kind==="local_refusal"?(spec.status!==null||typeof spec.expected_error!=="string"||!/^[a-z][a-z0-9_]{1,63}$/.test(spec.expected_error)):
        (!Number.isInteger(spec.status)||spec.expected_error!==undefined))||
      spec.kind==="success"&&(spec.status!<200||spec.status!>=400)||spec.kind==="refusal"&&(spec.status!<400||spec.status!>=500)||
      spec.result_view!==undefined&&(spec.result_view!=="complete_jsonl"||spec.call.operation_id!=="getSyncStream"||spec.kind!=="success"||spec.status!==200)||
      spec.context!==undefined&&(!spec.context||Object.keys(spec.context).some(key=>!["ref","generation"].includes(key))||
        typeof spec.context.ref!=="string"||!spec.context.ref||spec.context.ref.length>200||!Number.isSafeInteger(spec.context.generation)||spec.context.generation<1))
      integrationFailure("fixture_case","A case needs an exact status and named semantic assertions");
    if(this.revalidate&&spec.mutates)integrationFailure("fixture_replay","Completed feature runs may only be revalidated with non-mutating cases");
    if(this.revalidate){
      const original=this.state.cases.find(item=>item.id===spec.id);
      if(!original||original.state!=="passed"||original.mutates||original.actor!==spec.actor||original.expected_status!==spec.status||original.kind!==spec.kind||
        !isDeepStrictEqual(original.input,spec.call)||!isDeepStrictEqual(original.context,spec.context)||original.expected_error!==spec.expected_error||original.result_view!==spec.result_view||
        !isDeepStrictEqual(original.assertions.toSorted(),spec.assertions.toSorted()))
        integrationFailure("fixture_replay","Revalidation must match a previously passed non-mutating case exactly");
    }
    if(this.current().some(item=>item.id===spec.id)||this.current().length>=this.caseLimit)integrationFailure("fixture_case","Duplicate or excessive feature cases");
    const op=operation(spec.call.operation_id),receipt:CaseReceipt={id:spec.id,actor:spec.actor,operation_id:op.operationId,method:op.method,path:op.path,
      expected_status:spec.status,status:null,kind:spec.kind,mutates:spec.mutates,state:"prepared",assertions:[],input:structuredClone(spec.call),created_at:new Date().toISOString(),
      auth_route:spec.context?"explicit_context":"api_key",...(spec.context?{context:structuredClone(spec.context)}:{}),...(spec.expected_error?{expected_error:spec.expected_error}:{}),...(spec.result_view?{result_view:spec.result_view}:{})};
    this.current().push(receipt);this.save();
    const principal=this.context.actors[spec.actor].principal;
    let outcome:"pending"|"known"|"unknown"="pending";
    try{
      let result:any;
      try{
        const beforeSend=()=>{receipt.state="sent";receipt.sent_at=new Date().toISOString();this.save();};
        const resolver=this.control.resolver(principal,op.operationId,spec.context?.ref);
        if(spec.context){
          const selected=this.contexts.check(principal,spec.context.ref,spec.context.generation);
          receipt.auth_context_kind=selected.kind==="session"?(selected.mode==="general_session"?"explicit_session_workflow":"session_special"):selected.kind==="public"?"public_auth":selected.kind;
          this.save();
          result=await this.contexts.call(principal,spec.context.ref,spec.call,resolver,{}, {beforeSend});
        }else result=await this.context.executor.call(principal,spec.call,resolver,{beforeSend});
      }catch(error){
        if(spec.kind!=="local_refusal"||receipt.state==="sent"||!(error instanceof BridgeError)||error.code!==spec.expected_error)throw error;
        result={state:"locally_refused",diagnostic:{code:error.code}};
        receipt.diagnostic_code=error.code;
      }
      outcome=result.state==="outcome_unknown"?"unknown":"known";
      receipt.status=result.upstream?.status ?? null;receipt.result_ref=result.result_ref ?? undefined;this.save();
      if(result.state==="outcome_unknown")integrationFailure("fixture_outcome_unknown","Feature request may have changed data; do not replay");
      if(spec.kind==="local_refusal"){
        if(result.state!=="locally_refused"||receipt.sent_at||receipt.status!==null)integrationFailure("fixture_observation","Expected a local refusal before dispatch");
      }else{
        if(result.state!=="completed"||receipt.status!==spec.status||result.truncated&&!spec.result_view)integrationFailure("fixture_observation","Unexpected, incomplete or unvalidated feature response");
        if(spec.result_view==="complete_jsonl"){
          const saved=this.context.vault.get(principal,result.result_ref,"result"),projection=saved.projection;
          if(saved.raw.interrupted||saved.decoded_complete!==true||projection?.kind!=="jsonl"||projection.complete!==true||projection.error||
            !Number.isSafeInteger(projection.total_records)||projection.total_records<1||!["SyncCompleteV1","SyncResetV1"].includes(projection.terminal))
            integrationFailure("fixture_observation","A paged stream must have a complete validated projection and terminal");
          if(spec.context)this.contexts.assertResult(principal,saved);
        }
        if(spec.context&&result.auth_context_kind!==receipt.auth_context_kind)integrationFailure("fixture_route","Response authentication route differs from the selected context");
      }
      const checked=new Set<string>();
      const check=(condition:unknown,id:string)=>{
        if(!spec.assertions.includes(id)||checked.has(id))integrationFailure("fixture_assertion","Unexpected or repeated semantic assertion");
        if(!condition)integrationFailure("fixture_assertion","A feature assertion did not hold");
        checked.add(id);receipt.assertions.push(id);
      };
      await verify(result,check);
      if(checked.size!==spec.assertions.length)integrationFailure("fixture_assertion","A required semantic assertion was not evaluated");
      receipt.state="passed";receipt.completed_at=new Date().toISOString();this.save();return result;
    }catch(error){
      receipt.state=outcome==="unknown"||outcome==="pending"&&receipt.state==="sent"?"outcome_unknown":"failed";receipt.diagnostic_code=diagnostic(error);receipt.completed_at=new Date().toISOString();this.save();throw error;
    }
  }
  finish(){
    if(this.completedCommit)return;
    if(!this.current().length||this.current().some(item=>item.state!=="passed"))integrationFailure("fixture_assertion","All planned cases must pass before completion");
    if(this.revalidate){this.state.validation!.state="completed";this.state.validation!.completed_at=new Date().toISOString();}
    else{this.state.state="completed";this.state.completed_at=new Date().toISOString();}
    this.save();this.completedCommit=true;
  }
  fail(error:unknown){
    if(this.completedCommit)return;
    if(this.revalidate){this.state.validation!.state="failed";this.state.validation!.diagnostic_code=diagnostic(error);this.state.validation!.completed_at=new Date().toISOString();}
    else{this.state.state="recovery_required";this.state.diagnostic_code=diagnostic(error);}
    this.save();
  }
  report(){
    const summary=(c:CaseReceipt)=>({id:c.id,actor:c.actor,operation_id:c.operation_id,method:c.method,path:c.path,kind:c.kind,mutates:c.mutates,
      expected_status:c.expected_status,status:c.status,state:c.state,auth_route:c.auth_route??"api_key",auth_context_kind:c.auth_context_kind,expected_error:c.expected_error,result_view:c.result_view,assertions:c.assertions,created_at:c.created_at,sent_at:c.sent_at,completed_at:c.completed_at,diagnostic_code:c.diagnostic_code});
    const all=this.state.cases,real=this.state.execution_scope==="real_immich_feature_run";
    const operations=registry.operations.map(op=>{
      const cases=all.filter(c=>c.operation_id===op.operationId),success=cases.filter(c=>c.kind==="success"&&c.state==="passed").length,refused=cases.filter(c=>c.kind==="refusal"&&c.state==="passed").length,local=cases.filter(c=>c.kind==="local_refusal"&&c.state==="passed").length;
      return {operation_id:op.operationId,method:op.method,path:op.path,tag:op.tag,real_success_cases:real?success:0,real_refusal_cases:real?refused:0,
        harness_success_cases:real?0:success,harness_refusal_cases:real?0:refused,real_local_refusal_cases:real?local:0,harness_local_refusal_cases:real?0:local,integration_success:real&&success?"observed":"not_run",
        upstream_refusal:real&&refused?"observed":"not_run",feature_acceptance:"incomplete",cases:cases.map(summary)};
    });
    return {format:"immich-mcp-feature-report",version:1,plan:this.plan,run_id:this.state.run_id,immich_version:registry.version,source_commit:registry.commit,openapi_sha256:registry.sha256,
      execution_scope:this.state.execution_scope,evidence_scope:"named_semantic_cases_only",fixture_state:this.state.state,created_at:this.state.created_at,updated_at:this.state.updated_at,
      completed_at:this.state.completed_at,diagnostic_code:this.state.diagnostic_code,operations,
      categories:[...new Set(registry.operations.map(op=>op.tag))].sort().map(tag=>({tag,real_success_cases:operations.filter(op=>op.tag===tag).reduce((n,op)=>n+op.real_success_cases,0),
        harness_success_cases:operations.filter(op=>op.tag===tag).reduce((n,op)=>n+op.harness_success_cases,0),feature_acceptance:"incomplete"})),
      latest_validation:this.state.validation?{...this.state.validation,cases:this.state.validation.cases.map(summary)}:undefined,
      api_integration_completed:false,completed_41_category_acceptance:false,full_acceptance:false,cloudflare:"not_run",chatgpt:"not_run"};
  }
  async publish(){
    const path=join(this.context.lab.state.root,this.plan+".report.json"),temporary=join(this.context.lab.state.root,".feature-report-"+randomUUID()+".json");
    try{
      await writeFile(temporary,JSON.stringify(this.report(),null,2)+"\n",{flag:"wx",mode:0o600,flush:true});
      await rename(temporary,path);await syncDirectory(this.context.lab.state.root);return path;
    }catch{throw new BridgeError("fixture_report_failed","Encrypted feature evidence is retained; the public report could not be published");}
  }
}
