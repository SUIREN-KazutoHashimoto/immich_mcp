import { createHash,randomBytes,randomUUID } from "node:crypto";
import { lstat,mkdir,open,realpath,writeFile,rename } from "node:fs/promises";
import { join } from "node:path";
import { Vault } from "./vault.js";
import { Executor } from "./executor.js";
import { Contexts } from "./contexts.js";
import { prepare,type Resolver } from "./serializer.js";
import { operation,registry } from "./registry.js";
import { validator } from "./schema.js";
import { readDecoded } from "./content-encoding.js";
import { sendUpstream,releaseUpstream } from "./upstream.js";
import { withRunningLab,type LabOptions,type LabState,type RunningLab } from "./integration-lab.js";
import { syncDirectory } from "./vault-rekey.js";
import { sameApiKeyId } from "./key-identity.js";
import { BridgeError,type ApiCall } from "./types.js";

const CONTROL="__integration_fixture_bootstrap",FOREVER=Number.MAX_SAFE_INTEGER;
export const FIXTURE_ROLES=["admin","a","b","restricted"] as const;
export type FixtureRole=typeof FIXTURE_ROLES[number];
type Scope="harness_only"|"real_immich_bootstrap";
interface Actor {role:FixtureRole;owner:FixtureRole;principal:string;email?:string;name?:string;password?:string;user_id?:string;session?:string;public_context?:string;}
interface Step {id:string;actor:FixtureRole;operation_id:string;method:string;path:string;route:string;state:string;status:number|null;result_ref?:string;raw_ref?:string;diagnostic_code?:string;}
interface Bootstrap {version:1;run_id:string;endpoint:string;state:"started"|"completed"|"recovery_required";execution_scope:Scope;steps:Step[];created_at:string;updated_at:string;completed_at?:string;credential_check?:{state:"passed"|"failed";checked_at:string;actor?:FixtureRole;status?:number|null;diagnostic_code?:string};diagnostic_code?:string;}
const fail=(code:string,message:string):never=>{throw new BridgeError(code,message);};
const permissions=(role:FixtureRole)=>role==="restricted"?["asset.read"]:["all"];
const code=(error:unknown)=>error instanceof BridgeError&&/^[a-z][a-z0-9_]{1,63}$/.test(error.code)?error.code:"fixture_request_failed";
export function fixturePrincipal(runId:string,role:FixtureRole){
  return createHash("sha256").update(JSON.stringify(["https://integration.invalid/"+runId,role])).digest("hex");
}
export function fixtureServerId(s:Pick<LabState,"id"|"port">){
  return createHash("sha256").update(JSON.stringify(["immich-mcp-isolated-fixtures-v1",s.id,"http://127.0.0.1:"+s.port+"/api"])).digest("hex");
}
async function fixtureKey(path:string){
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.size!==32n)fail("fixture_key","Expected the original 32-byte fixture key");
  const handle=await open(path,"r");
  try{
    const info=await handle.stat({bigint:true});if(info.dev!==before.dev||info.ino!==before.ino)fail("fixture_key","Fixture key identity changed");
    const bytes=Buffer.alloc(33);let offset=0;
    while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,null);if(!part.bytesRead)break;offset+=part.bytesRead;}
    if(offset!==32){bytes.fill(0);fail("fixture_key","Expected a 32-byte fixture key");}
    const key=Buffer.from(bytes.subarray(0,32));bytes.fill(0);return key;
  }finally{await handle.close();}
}
async function openFixtureVault(s:Readonly<LabState>){
  const directory=join(s.root,"fixtures");
  try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)fail("fixture_path","Use the original private fixture directory");
  const key=await fixtureKey(join(s.root,".vault.key"));
  try{return new Vault(directory,key,fixtureServerId(s));}finally{key.fill(0);}
}
function stored(vault:Vault):Bootstrap|undefined{
  const row=vault.db.prepare("SELECT id FROM records WHERE principal=? AND id=? AND kind=?").get(CONTROL,"bootstrap","fixture_bootstrap");
  return row?vault.get(CONTROL,"bootstrap","fixture_bootstrap"):undefined;
}
function save(vault:Vault,value:Bootstrap){value.updated_at=new Date().toISOString();vault.put(CONTROL,"fixture_bootstrap",value,FOREVER,"bootstrap");}
function actor(vault:Vault,runId:string,role:FixtureRole):Actor{return vault.get(fixturePrincipal(runId,role),"actor","fixture_actor");}
function putActor(vault:Vault,value:Actor){vault.put(value.principal,"fixture_actor",value,FOREVER,"actor");}
function assertPermissions(actual:any,expected:string[]){
  if(!Array.isArray(actual)||actual.length!==expected.length||actual.some(x=>typeof x!=="string")||[...actual].sort().join("\n")!==[...expected].sort().join("\n"))
    fail("fixture_key_permissions","Fixture key permissions do not match the requested exact set");
}
function assertResult(result:any,status:number){
  if(result.state!=="completed"||result.upstream?.status!==status||result.truncated||!result.result_ref){
    const state=["completed","failed","outcome_unknown"].includes(result.state)?result.state:"unknown";
    const observed=Number.isInteger(result.upstream?.status)?String(result.upstream.status):"none";
    const code=typeof result.diagnostic?.code==="string"&&/^[a-z][a-z0-9_]{1,63}$/.test(result.diagnostic.code)?result.diagnostic.code:"none";
    fail("fixture_response","Expected a complete setup response (state="+state+", status="+observed+", diagnostic="+code+")");
  }
  return result.data;
}
function boundToken(value:any):string{
  if(typeof value!=="string"||!value||value.length>16384||/[\r\n\0;]/.test(value))fail("fixture_credential","Invalid setup credential");
  return value;
}
function callInput(vault:Vault,principal:string,id:string,body?:Record<string,any>){
  const input:ApiCall={operation_id:id,...(body?{body:structuredClone(body)}:{})};
  for(const rule of registry.secretRules.flatMap(r=>r.bindings).filter(b=>b.operation_id===id&&b.direction==="request")){
    const pointer=rule.instance_pointer_pattern;
    if(!/^\/[A-Za-z][A-Za-z0-9]*$/.test(pointer))fail("fixture_contract","Setup secret contract must be an exact top-level field");
    const name=pointer.slice(1);
    if(!input.body||input.body[name]===undefined||input.body[name]===null)continue;
    const ref=vault.put(principal,"fixture_input",{operation_id:id,pointer,value:input.body[name]},FOREVER);
    delete input.body[name];(input.secret_bindings ??= []).push({location:"body",pointer,secret_ref:ref});
  }
  const resolver:Resolver={
    file:async()=>fail("fixture_contract","Account setup does not accept files"),
    secret:async(ref,location,pointer)=>{
      const value=vault.get(principal,ref,"fixture_input");
      if(location!=="body"||value.operation_id!==id||value.pointer!==pointer)fail("fixture_contract","Setup secret provenance differs");
      return value.value;
    }
  };
  return {input,resolver};
}
async function* responseChunks(response:Response){
  const reader=response.body?.getReader();if(!reader)return;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;yield chunk.value;}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
class Setup {
  constructor(readonly lab:RunningLab,readonly vault:Vault,readonly executor:Executor,readonly contexts:Contexts,readonly meta:Bootstrap){}
  current(role:FixtureRole){return actor(this.vault,this.lab.state.id,role);}
  async step<T>(role:FixtureRole,id:string,route:string,work:(step:Step,sent:()=>void)=>Promise<T>){
    if(this.meta.steps.length>=64)fail("fixture_step_limit","Setup receipt limit reached");
    const op=operation(id),step:Step={id:randomUUID(),actor:role,operation_id:id,method:op.method,path:op.path,route,state:"prepared",status:null};
    this.meta.steps.push(step);save(this.vault,this.meta);
    try{
      const value=await work(step,()=>{step.state="sent";save(this.vault,this.meta);});
      step.state="completed";save(this.vault,this.meta);return value;
    }catch(error){
      step.state=(step.status!==null&&step.status>=300||error instanceof BridgeError&&error.code==="key_validation_failed")?"upstream_refusal":step.state==="prepared"?"failed":"outcome_unknown";step.diagnostic_code=code(error);save(this.vault,this.meta);throw error;
    }
  }
  async common(role:FixtureRole,id:string,status:number,body?:Record<string,any>,publicRoute=false){
    const who=this.current(role),request=callInput(this.vault,who.principal,id,body);
    return this.step(role,id,publicRoute?"common_executor_public":"common_executor_api_key",async(step,sent)=>{
      const result=publicRoute?await this.contexts.call(who.principal,who.public_context!,request.input,request.resolver,{}, {beforeSend:sent}):
        await this.executor.call(who.principal,request.input,request.resolver,{beforeSend:sent});
      step.status=result.upstream?.status ?? null;step.result_ref=result.result_ref ?? undefined;save(this.vault,this.meta);
      const data=assertResult(result,status);return {data,result};
    });
  }
  async publicContext(role:FixtureRole){
    const who=this.current(role),context=await this.contexts.register(who.principal,{kind:"public",acknowledge:true,ttl_seconds:86400});
    who.public_context=context.context_ref;putActor(this.vault,who);
  }
  async login(role:FixtureRole){
    const who=this.current(role),{data,result}=await this.common(role,"login",201,{email:who.email,password:who.password},true);
    if(data.userId!==who.user_id||data.userEmail!==who.email||data.isAdmin!==(role==="admin"))fail("fixture_owner","Login returned a different setup owner");
    const ref=data.accessToken?.secret_ref;
    if(typeof ref!=="string")fail("fixture_credential","Login did not produce a protected session reference");
    const secret=this.vault.get(who.principal,ref,"secret"),origin=this.vault.get(who.principal,result.result_ref!,"result");
    if(secret.context_ref!==origin.context_ref||secret.context_generation!==origin.context_generation)fail("fixture_credential","Session secret provenance differs");
    who.session=boundToken(secret.value);putActor(this.vault,who);
  }
  async createKey(role:FixtureRole,owner:FixtureRole){
    const who=this.current(role),source=this.current(owner);
    if(!source.user_id||who.user_id!==source.user_id)fail("fixture_owner","Key setup owner differs");
    const {input,resolver}=callInput(this.vault,who.principal,"createApiKey",{name:"immich-mcp-it-"+role+"-"+this.lab.state.id,permissions:permissions(role)});
    const request=await prepare(this.lab.observation.endpoint,input,resolver);
    request.headers.set("authorization","Bearer "+boundToken(source.session));request.headers.set("accept-encoding","identity");
    const key=await this.step(role,"createApiKey","explicit_own_session_key_bootstrap",async(step,sent)=>{
      const response=await sendUpstream(this.lab.http,request.url,{method:request.method,headers:request.headers,body:request.body as any,
        redirect:"manual",signal:AbortSignal.timeout(30000)},sent);
      try{
        step.status=response.status;
        const raw=await this.vault.capture(who.principal,responseChunks(response),65536,undefined,FOREVER,true);
        step.raw_ref=raw.raw_ref;this.vault.put(who.principal,"fixture_key_response",{raw,status:response.status,content_encoding:response.headers.get("content-encoding")??"identity"},FOREVER,step.id);save(this.vault,this.meta);
        if(response.status!==201||raw.interrupted)fail("fixture_key_response","Key creation did not return a complete expected response");
        const bytes=await readDecoded(this.vault.rawStream(who.principal,raw.raw_ref),response.headers.get("content-encoding")??"identity",65536);
        const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
        validator(operation("createApiKey").definition.responses["201"].content["application/json"].schema,registry.schemas)(value);
        assertPermissions(value.permissions,permissions(role));
        boundToken(value.secret);return value;
      }finally{releaseUpstream(response);}
    });
    this.vault.put(who.principal,"fixture_key",{owner,owner_user_id:source.user_id,key_id:key.id,permissions:key.permissions,secret:key.secret},FOREVER,"initial_key");
    await this.step(role,"getMyApiKey","sole_key_registration_probe",async(step,sent)=>{
      sent();await this.executor.register(who.principal,key.secret,0);step.status=200;
      if(!sameApiKeyId(this.vault.credential(who.principal).keyId,key.id))fail("fixture_key_identity","Registered setup key identity differs");
    });
    const verified=await this.common(role,"getMyApiKey",200);
    if(!sameApiKeyId(verified.data.id,key.id))fail("fixture_key_identity","Key verification identity differs");
    assertPermissions(verified.data.permissions,permissions(role));
  }
}
function report(lab:RunningLab,vault:Vault,meta:Bootstrap){
  const scope=meta.execution_scope==="harness_only"||lab.observation.execution_scope==="harness_only"?"harness_only":"real_immich_bootstrap";
  return {format:"immich-mcp-bootstrap-report",version:1,run_id:lab.state.id,immich_version:registry.version,source_commit:registry.commit,openapi_sha256:registry.sha256,
    execution_scope:scope,evidence_scope:"synthetic_account_and_key_setup_only",bootstrap_state:meta.state,diagnostic_code:meta.diagnostic_code,created_at:meta.created_at,updated_at:meta.updated_at,completed_at:meta.completed_at,credential_check:meta.credential_check,
    actors:FIXTURE_ROLES.map(role=>{
      const principal=fixturePrincipal(lab.state.id,role),binding=vault.binding(principal);
      return {role,owner:role==="restricted"?"a":role,key_registered:binding?.state==="active",key_id:binding?.key_id ?? null,requested_permissions:permissions(role)};
    }),
    categories:[...new Set(registry.operations.map(op=>op.tag))].sort().map(tag=>({tag,integration_success:"not_run"})),
    operations:registry.operations.map(op=>({operation_id:op.operationId,method:op.method,path:op.path,tag:op.tag,
      setup_observations:meta.steps.filter(step=>step.operation_id===op.operationId).map(step=>({actor:step.actor,route:step.route,state:step.state,status:step.status})),
      integration_success:"not_run",feature_acceptance:"incomplete"})),
    api_integration_completed:false,full_acceptance:false,cloudflare:"not_run",chatgpt:"not_run"};
}
async function publish(lab:RunningLab,vault:Vault,meta:Bootstrap){
  const value=report(lab,vault,meta),temporary=join(lab.state.root,".bootstrap-report-"+randomUUID()+".json");
  try{
    await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600,flush:true});
    await rename(temporary,join(lab.state.root,"bootstrap-report.json"));await syncDirectory(lab.state.root);return value;
  }catch{throw new BridgeError("fixture_report_failed","Setup evidence is retained; the public report could not be published");}
}
async function completed(lab:RunningLab,vault:Vault,executor:Executor,meta:Bootstrap){
  if(meta.execution_scope!=="harness_only"&&lab.observation.execution_scope==="harness_only"){meta.execution_scope="harness_only";save(vault,meta);}
  let current:FixtureRole|undefined,lastStatus:number|null=null;
  try{
    for(const role of FIXTURE_ROLES){
      current=role;lastStatus=null;
      const principal=fixturePrincipal(lab.state.id,role),key=vault.credential(principal),initial=vault.get(principal,"initial_key","fixture_key");
      const who=actor(vault,lab.state.id,role),owner=actor(vault,lab.state.id,who.owner);
      if(!sameApiKeyId(key.keyId,initial.key_id))fail("fixture_key_identity","A setup caller was rebound to a different API key");
      if(initial.owner!==who.owner||initial.owner_user_id!==who.user_id||who.user_id!==owner.user_id)fail("fixture_owner","Previously initialized setup owner changed");
      assertPermissions(initial.permissions,permissions(role));
      const value=await executor.call(principal,{operation_id:"getMyApiKey"});
      lastStatus=value.upstream?.status ?? null;const data=assertResult(value,200);
      if(!sameApiKeyId(data.id,key.keyId))fail("fixture_key_identity","Previously initialized key identity changed");
      assertPermissions(data.permissions,permissions(role));
    }
    meta.credential_check={state:"passed",checked_at:new Date().toISOString()};save(vault,meta);
  }catch(error){
    meta.credential_check={state:"failed",checked_at:new Date().toISOString(),actor:current,status:lastStatus,diagnostic_code:code(error)};
    save(vault,meta);await publish(lab,vault,meta);throw error;
  }
  const value=await publish(lab,vault,meta);
  return {state:"already_initialized",execution_scope:value.execution_scope,run_id:lab.state.id,synthetic_accounts:3,key_bindings:4,credential_check:"passed",report:join(lab.state.root,"bootstrap-report.json"),api_integration_completed:false,full_acceptance:false};
}
export async function bootstrapLab(directory:string,options:LabOptions={}){
  return withRunningLab(directory,async lab=>{
    const vault=await openFixtureVault(lab.state),executor=new Executor(lab.observation.endpoint,vault,lab.http,65536,65536,{resultTtlMs:86400000,maxDecodedBytes:65536});
    try{
      const contexts=new Contexts(vault,executor,"https://integration.invalid"),existing=stored(vault);
      if(existing){
        if(existing.version!==1||existing.run_id!==lab.state.id||existing.endpoint!==lab.observation.endpoint)fail("fixture_manifest","Fixture bootstrap belongs to a different run");
        if(existing.state!=="completed")fail("fixture_recovery_required","Previous setup may have changed the backend; prepare a new disposable run after review");
        return await completed(lab,vault,executor,existing);
      }
      const adminPrincipal=fixturePrincipal(lab.state.id,"admin"),publicContext=await contexts.register(adminPrincipal,{kind:"public",acknowledge:true,ttl_seconds:86400});
      const emptyResolver:Resolver={file:async()=>fail("fixture_contract","No setup files"),secret:async()=>fail("fixture_contract","No setup secret")};
      const initial=await contexts.call(adminPrincipal,publicContext.context_ref,{operation_id:"getServerConfig"},emptyResolver);
      if(assertResult(initial,200).isInitialized!==false)fail("fixture_not_fresh","Account bootstrap requires a fresh uninitialized isolated backend");
      const first=operation("getServerConfig"),meta:Bootstrap={version:1,run_id:lab.state.id,endpoint:lab.observation.endpoint,state:"started",
        execution_scope:lab.observation.execution_scope==="harness_only"?"harness_only":"real_immich_bootstrap",
        created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
        steps:[{id:randomUUID(),actor:"admin",operation_id:first.operationId,method:first.method,path:first.path,route:"common_executor_public",state:"completed",status:200,result_ref:initial.result_ref!}]};
      vault.storage.atomic(()=>{
        for(const role of ["admin","a","b"] as const)putActor(vault,{role,owner:role,principal:fixturePrincipal(lab.state.id,role),
          email:"mcp-it-"+lab.state.id.replaceAll("-","")+"-"+role+"@example.invalid",name:"MCP integration "+role,
          password:"It!"+randomBytes(30).toString("base64url")+"a1",...(role==="admin"?{public_context:publicContext.context_ref}:{})});
        save(vault,meta);
      });
      const setup=new Setup(lab,vault,executor,contexts,meta);let completionCommitted=false;
      try{
        const admin=setup.current("admin"),created=await setup.common("admin","signUpAdmin",201,{email:admin.email,name:admin.name,password:admin.password},true);
        if(created.data.isAdmin!==true)fail("fixture_owner","Initial setup did not create an administrator");
        admin.user_id=created.data.id;putActor(vault,admin);await setup.login("admin");await setup.createKey("admin","admin");
        for(const role of ["a","b"] as const){
          const who=setup.current(role),created=await setup.common("admin","createUserAdmin",201,{email:who.email,name:who.name,password:who.password,isAdmin:false,notify:false,shouldChangePassword:false});
          if(created.data.isAdmin!==false)fail("fixture_owner","General setup user unexpectedly has administrator rights");
          who.user_id=created.data.id;putActor(vault,who);await setup.publicContext(role);await setup.login(role);await setup.createKey(role,role);
        }
        const owner=setup.current("a");putActor(vault,{role:"restricted",owner:"a",principal:fixturePrincipal(lab.state.id,"restricted"),user_id:owner.user_id});
        await setup.createKey("restricted","a");meta.state="completed";meta.completed_at=new Date().toISOString();
        meta.credential_check={state:"passed",checked_at:meta.completed_at};save(vault,meta);completionCommitted=true;
        const value=await publish(lab,vault,meta);
        return {state:"initialized",execution_scope:value.execution_scope,run_id:lab.state.id,synthetic_accounts:3,key_bindings:4,credential_check:"passed",
          report:join(lab.state.root,"bootstrap-report.json"),api_integration_completed:false,full_acceptance:false};
      }catch(error){
        if(completionCommitted)throw new BridgeError("fixture_report_failed","Account/key setup is committed; retry only the completed setup checks and report");
        meta.state="recovery_required";meta.diagnostic_code=code(error);
        try{save(vault,meta);await publish(lab,vault,meta);}catch{/* The durable started/sent receipt still prevents automatic replay. */}
        throw new BridgeError("fixture_recovery_required","Setup did not finish; review encrypted evidence or prepare a new isolated run");
      }
    }finally{await executor.close();vault.close();}
  },options);
}

export interface FixtureActorInfo {role:FixtureRole;owner:FixtureRole;principal:string;user_id:string;key_id:string;revision:number;}
export interface InitializedFixtureLab {
  lab:RunningLab;vault:Vault;executor:Executor;actors:Readonly<Record<FixtureRole,FixtureActorInfo>>;
  executionScope:"harness_only"|"real_immich_feature_run";
}
export async function withInitializedFixtureLab<T>(directory:string,work:(context:InitializedFixtureLab)=>Promise<T>,options:LabOptions={}){
  return withRunningLab(directory,async lab=>{
    const vault=await openFixtureVault(lab.state),executor=new Executor(lab.observation.endpoint,vault,lab.http,16*1024*1024,512*1024,{resultTtlMs:86400000,maxDecodedBytes:32*1024*1024});
    try{
      const meta=stored(vault) ?? fail("fixture_bootstrap_required","Complete account/key bootstrap before creating feature fixtures");
      if(meta.state!=="completed")fail("fixture_bootstrap_required","Complete account/key bootstrap before creating feature fixtures");
      if(meta.version!==1||meta.run_id!==lab.state.id||meta.endpoint!==lab.observation.endpoint)fail("fixture_manifest","Fixture bootstrap belongs to a different run");
      await completed(lab,vault,executor,meta);
      const actors=Object.fromEntries(FIXTURE_ROLES.map(role=>{
        const who=actor(vault,lab.state.id,role),credential=vault.credential(who.principal);
        if(typeof who.user_id!=="string")fail("fixture_owner","Missing fixture owner identity");
        return [role,Object.freeze({role,owner:who.owner,principal:who.principal,user_id:who.user_id,key_id:credential.keyId,revision:credential.revision})];
      })) as Record<FixtureRole,FixtureActorInfo>;
      const executionScope=meta.execution_scope==="harness_only"||lab.observation.execution_scope==="harness_only"?"harness_only":"real_immich_feature_run";
      return await work({lab,vault,executor,actors:Object.freeze(actors),executionScope});
    }finally{await executor.close();vault.close();}
  },options);
}
