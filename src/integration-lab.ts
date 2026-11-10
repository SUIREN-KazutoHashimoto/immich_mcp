import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from "node:crypto";
import { mkdir,lstat,realpath,readFile,writeFile,rename,open } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./types.js";
import { operation,registry } from "./registry.js";
import { validator } from "./schema.js";
import { syncDirectory } from "./vault-rekey.js";
import { Upstream } from "./upstream.js";

export const LAB_SOURCE="8303cb117e197c700332b33b61b45314c9cc5bb4";
export const LAB_IMAGES=Object.freeze({
  server:"ghcr.io/immich-app/immich-server@sha256:485d546a2e31d6a8b4db8423fcba5c109de8c218d93410af115fd1ccfc4352a6",
  machineLearning:"ghcr.io/immich-app/immich-machine-learning@sha256:5b28c9352c8374b8a1ed96fbdd8d6755fea6e43510ec43fdf6538aa02ea40f56",
  redis:"docker.io/valkey/valkey:9@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d",
  database:"ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23"
});
// Keep the original v1 references for authenticated existing runs. They are never
// selected for a newly prepared run or silently upgraded during checks/teardown.
const LEGACY_LAB_IMAGES=Object.freeze({...LAB_IMAGES,
  server:"ghcr.io/immich-app/immich-server:v3.3.5",
  machineLearning:"ghcr.io/immich-app/immich-machine-learning:v3.3.5",
});
const LABEL="io.immich-mcp.integration.run",MAX_FILE=65536;
type Identity={dev:string;ino:string};
export interface LabState {
  format:"immich-mcp-isolated-run";version:1|2;id:string;project:string;root:string;identity:Identity;port:number;
  source_commit:string;openapi_sha256:string;compose_sha256:string;env_sha256:string;created_at:string;
  engine_id?:string;start_requested?:boolean;delete_requested?:boolean;destroyed?:boolean;harness_used?:boolean;
}
export type DockerRunner=(args:string[],timeoutMs?:number)=>Promise<string>;
export interface LabOptions {docker?:DockerRunner;http?:typeof fetch;}
const fail=(code:string,message:string):never=>{throw new BridgeError(code,message);};
const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel);};
const volumeNames=(s:LabState)=>["library","database","models","redis"].map(name=>s.project+"_"+name);
const networkNames=(s:LabState)=>["isolated","egress"].map(name=>s.project+"_"+name);
function images(version:LabState["version"]|undefined){
  if(version===undefined||version===2)return LAB_IMAGES;
  if(version===1)return LEGACY_LAB_IMAGES;
  return fail("lab_manifest","Unsupported laboratory image policy");
}
function imagePolicy(s:Pick<LabState,"version">){return s.version===2?"pinned_oci_index":"legacy_tags";}
export function labCompose(s:Pick<LabState,"id"|"project"|"port">&Partial<Pick<LabState,"version">>){
  const selected=images(s.version),labels={[LABEL]:s.id};
  const volume=(name:string)=>({name:s.project+"_"+name,labels});
  return {
    name:s.project,
    services:{
      "immich-server":{image:selected.server,labels,restart:"no",
        environment:{DB_HOSTNAME:"database",DB_PORT:"5432",DB_USERNAME:"postgres",DB_DATABASE_NAME:"immich",
          DB_PASSWORD:"${DB_PASSWORD:?Use the private generated env file}",REDIS_HOSTNAME:"redis",REDIS_PORT:"6379",IMMICH_LOG_LEVEL:"warn"},
        volumes:["library:/data"],ports:[{target:2283,published:String(s.port),host_ip:"127.0.0.1",protocol:"tcp"}],
        depends_on:{redis:{condition:"service_healthy"},database:{condition:"service_healthy"}},healthcheck:{disable:false},networks:["isolated","egress"]},
      "immich-machine-learning":{image:selected.machineLearning,labels,restart:"no",volumes:["models:/cache"],healthcheck:{disable:false},networks:["isolated","egress"]},
      redis:{image:selected.redis,labels,restart:"no",volumes:["redis:/data"],networks:["isolated"],
        healthcheck:{test:["CMD","redis-cli","ping"],interval:"5s",timeout:"3s",retries:30}},
      database:{image:selected.database,labels,restart:"no",environment:{POSTGRES_PASSWORD:"${DB_PASSWORD:?Use the private generated env file}",
        POSTGRES_USER:"postgres",POSTGRES_DB:"immich",POSTGRES_INITDB_ARGS:"--data-checksums"},volumes:["database:/var/lib/postgresql/data"],
        shm_size:"128mb",networks:["isolated"],healthcheck:{disable:false}}
    },
    volumes:{library:volume("library"),database:volume("database"),models:volume("models"),redis:volume("redis")},
    networks:{isolated:{name:s.project+"_isolated",internal:true,labels},egress:{name:s.project+"_egress",labels}}
  };
}
async function regular(path:string,max:number){
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.size>BigInt(max))fail("lab_file","Expected a bounded regular laboratory file");
  const handle=await open(path,"r");
  try{
    const info=await handle.stat({bigint:true});
    if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino)fail("lab_file","Laboratory file identity changed");
    const bytes=Buffer.alloc(max+1);let offset=0;
    while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,null);if(!part.bytesRead)break;offset+=part.bytesRead;}
    if(offset>max)fail("lab_file","Laboratory file exceeds its limit");return Buffer.from(bytes.subarray(0,offset));
  }finally{await handle.close();}
}
async function rootIdentity(path:string):Promise<Identity>{
  const info=await lstat(path,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)fail("lab_path","Use the original canonical run directory");
  return {dev:String(info.dev),ino:String(info.ino)};
}
function signature(payload:string,key:Buffer){return createHmac("sha256",key).update("immich-mcp-isolated-run-v1\n").update(payload).digest();}
async function save(state:LabState,key:Buffer,initial=false){
  const payload=JSON.stringify(state),document=JSON.stringify({format:1,payload,mac:signature(payload,key).toString("hex")})+"\n",path=join(state.root,"run.json");
  if(initial)await writeFile(path,document,{flag:"wx",mode:0o600,flush:true});
  else{
    const temp=join(state.root,".run-"+randomUUID()+".json");await writeFile(temp,document,{flag:"wx",mode:0o600,flush:true});await rename(temp,path);
  }
  await syncDirectory(state.root);
}
async function checkoutRoot(){
  let path=dirname(fileURLToPath(import.meta.url));
  for(let depth=0;depth<5;depth++,path=dirname(path)){
    try{if(JSON.parse((await readFile(join(path,"package.json"))).toString()).name==="immich-mcp")return await realpath(path);}catch{}
  }
  return fail("lab_path","Cannot locate the project boundary");
}
export async function prepareLab(directory:string,port=22835){
  if(!isAbsolute(directory)||!Number.isSafeInteger(port)||port<1024||port>65535)fail("lab_path","Use an absolute new run directory and a nonprivileged local port");
  const parent=await realpath(dirname(resolve(directory))),root=join(parent,basename(resolve(directory))),checkout=await checkoutRoot();
  if(within(checkout,root))fail("lab_path","Keep private run directories outside the checkout/build context");
  try{await mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")fail("destination_exists","Run directory must not already exist");throw error;}
  const id=randomUUID(),project="immich-mcp-it-"+id.replaceAll("-",""),key=randomBytes(32);
  try{
    const compose=JSON.stringify(labCompose({id,project,port,version:2}),null,2)+"\n",env="DB_PASSWORD="+randomBytes(32).toString("hex")+"\n";
    await writeFile(join(root,".run.key"),key,{flag:"wx",mode:0o600,flush:true});
    await writeFile(join(root,".vault.key"),randomBytes(32),{flag:"wx",mode:0o600,flush:true});
    await writeFile(join(root,"compose.yaml"),compose,{flag:"wx",mode:0o600,flush:true});await writeFile(join(root,".env"),env,{flag:"wx",mode:0o600,flush:true});
    const state:LabState={format:"immich-mcp-isolated-run",version:2,id,project,root,identity:await rootIdentity(root),port,
      source_commit:LAB_SOURCE,openapi_sha256:registry.sha256,compose_sha256:sha(compose),env_sha256:sha(env),created_at:new Date().toISOString()};
    await save(state,key,true);await syncDirectory(parent);
    return {state:"prepared",manifest_version:state.version,image_reference_policy:imagePolicy(state),configured_images_pinned:true,directory:root,project,port,immich_version:"3.3.5",execution_scope:"preparation_only",docker_executed:false};
  }finally{key.fill(0);}
}
async function load(directory:string,checkFiles=true){
  if(!isAbsolute(directory))fail("lab_path","Use an absolute run directory");const root=resolve(directory),identity=await rootIdentity(root);
  const key=await regular(join(root,".run.key"),32);
  try{
    if(key.length!==32)fail("lab_key","Invalid laboratory owner key");
    const envelope=JSON.parse((await regular(join(root,"run.json"),MAX_FILE)).toString("utf8"));
    if(envelope?.format!==1||typeof envelope.payload!=="string"||typeof envelope.mac!=="string"||!/^[a-f0-9]{64}$/.test(envelope.mac)||
      !timingSafeEqual(signature(envelope.payload,key),Buffer.from(envelope.mac,"hex")))fail("lab_authentication","Laboratory manifest authentication failed");
    const s=JSON.parse(envelope.payload) as LabState;
    if(s.format!=="immich-mcp-isolated-run"||![1,2].includes(s.version)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s.id)||
      s.project!=="immich-mcp-it-"+s.id.replaceAll("-","")||s.root!==root||s.identity?.dev!==identity.dev||s.identity?.ino!==identity.ino||
      !Number.isSafeInteger(s.port)||s.port<1024||s.port>65535||s.source_commit!==LAB_SOURCE||s.openapi_sha256!==registry.sha256||
      !Number.isFinite(Date.parse(s.created_at))||
      [s.start_requested,s.delete_requested,s.destroyed,s.harness_used].some(v=>v!==undefined&&typeof v!=="boolean")||s.destroyed&&!s.delete_requested||![s.compose_sha256,s.env_sha256].every(x=>/^[a-f0-9]{64}$/.test(x))||
      s.engine_id!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(s.engine_id))fail("lab_manifest","Invalid laboratory manifest");
    if(checkFiles){
      const compose=await regular(join(root,"compose.yaml"),MAX_FILE),env=await regular(join(root,".env"),1024);
      if(sha(compose)!==s.compose_sha256||sha(env)!==s.env_sha256)fail("lab_changed","Laboratory configuration changed");
      let parsed:unknown;
      try{parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(compose));}
      catch{fail("lab_changed","Laboratory configuration is not the selected template");}
      if(!isDeepStrictEqual(parsed,labCompose(s))||!/^DB_PASSWORD=[a-f0-9]{64}\n$/.test(env.toString("utf8")))
        fail("lab_changed","Laboratory configuration is not the selected template");
    }
    return {state:s,key};
  }catch(error){key.fill(0);throw error;}
}
function ownershipLock(root:string){
  const path=join(root,".lab-owner.sqlite"),db=new DatabaseSync(path);
  try{
    db.exec("PRAGMA busy_timeout=1000;PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE;");
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get())db.exec("CREATE TABLE lab_owner(version INTEGER PRIMARY KEY);INSERT INTO lab_owner VALUES(1)");
    const rows=db.prepare("SELECT version FROM lab_owner").all();if(rows.length!==1||rows[0]!.version!==1)fail("lab_schema","Unsupported laboratory owner schema");
    db.exec("COMMIT");return db;
  }catch(error){if(db.isTransaction)db.exec("ROLLBACK");db.close();throw error;}
}
async function owned<T>(directory:string,checkFiles:boolean,work:(s:LabState,key:Buffer)=>Promise<T>){
  const first=await load(directory,checkFiles);first.key.fill(0);
  const info=await lstat(join(first.state.root,".lab-owner.sqlite")).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return undefined;});
  if(info&&(!info.isFile()||info.isSymbolicLink()))fail("lab_path","Invalid laboratory owner file");
  const lock=ownershipLock(first.state.root);let key:Buffer|undefined;
  try{const next=await load(directory,checkFiles);key=next.key;return await work(next.state,key);}
  finally{key?.fill(0);lock.close();}
}
export const runDocker:DockerRunner=(args,timeoutMs=60000)=>new Promise((resolve,reject)=>{
  const env={...process.env};
  if(args[0]==="--host"){delete env.DOCKER_HOST;delete env.DOCKER_CONTEXT;delete env.DOCKER_TLS_VERIFY;delete env.DOCKER_CERT_PATH;}
  const child=spawn("docker",args,{windowsHide:true,stdio:["ignore","pipe","pipe"],shell:false,env});
  let output="",received=0,limited=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  const accept=(chunk:Buffer,stdout:boolean)=>{received+=chunk.length;if(received>1024*1024){limited=true;child.kill();return;}if(stdout)output+=chunk.toString("utf8");};
  child.stdout!.on("data",c=>accept(c,true));child.stderr!.on("data",c=>accept(c,false));
  child.once("error",error=>{clearTimeout(timer);reject(new BridgeError((error as NodeJS.ErrnoException).code==="ENOENT"?"docker_unavailable":"docker_failed","Docker could not execute the requested laboratory step"));});
  child.once("close",code=>{clearTimeout(timer);if(code!==0||limited||timedOut)reject(new BridgeError(timedOut?"docker_timeout":limited?"docker_output_limit":"docker_failed","Docker laboratory step did not complete"));else resolve(output.trim());});
});
export function localDockerRunner(env:NodeJS.ProcessEnv=process.env,invoke:DockerRunner=runDocker):DockerRunner {
  let selected:Promise<string>|undefined;
  return async(args,timeoutMs)=>{
    const host=await (selected ??= (async()=>{
      const context=env.DOCKER_CONTEXT?.trim();
      const supplied=context?undefined:(env.DOCKER_HOST?.trim()||undefined);
      const value=supplied ?? JSON.parse(await invoke(["context","inspect",...(context?[context]:[]),"--format","{{json .Endpoints.docker.Host}}"]));
      if(typeof value!=="string"||/[\r\n\0?#]/.test(value)||!(value.startsWith("unix:///")&&!value.includes("\\")||/^npipe:\/{4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(value)))
        fail("lab_remote_daemon","Run laboratory commands on the Docker host using a local Unix socket or Windows named pipe");
      return value;
    })());
    return invoke(["--host",host,...args],timeoutMs);
  };
}
async function engine(s:LabState,docker:DockerRunner){
  const id=(await docker(["info","--format","{{.ID}}"])).trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(id)||s.engine_id&&s.engine_id!==id)fail("lab_engine","Docker daemon identity changed");
  if((await docker(["info","--format","{{.OSType}}"])).trim()!=="linux")fail("lab_engine","The laboratory requires Linux containers");
  return id;
}
function ids(output:string,kind:"container"|"network"|"volume"){
  const result=output.trim()?output.trim().split(/\r?\n/):[];
  if(result.length>16||new Set(result).size!==result.length||result.some(id=>kind==="volume"?!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id):!/^[a-f0-9]{12,64}$/.test(id)))
    fail("lab_resources","Unexpected Docker resource inventory");
  return result;
}
interface Resources {containers:any[];volumes:any[];networks:any[];}
async function resources(s:LabState,docker:DockerRunner):Promise<Resources>{
  const filter="label=com.docker.compose.project="+s.project;
  const containers=ids(await docker(["ps","-aq","--filter",filter]),"container");
  const volumes=ids(await docker(["volume","ls","-q","--filter",filter]),"volume");
  const networks=ids(await docker(["network","ls","-q","--filter",filter]),"network");
  const parse=async(args:string[],expected:number)=>{if(!expected)return [];const value=JSON.parse(await docker(args));if(!Array.isArray(value)||value.length!==expected)fail("lab_resources","Docker inspection does not match its inventory");return value;};
  const r={containers:await parse(["inspect","--type","container",...containers],containers.length),
    volumes:await parse(["volume","inspect",...volumes],volumes.length),networks:await parse(["network","inspect",...networks],networks.length)};
  validateResources(s,r);return r;
}
function labels(s:LabState,value:any){
  if(value?.[LABEL]!==s.id||value?.["com.docker.compose.project"]!==s.project)fail("lab_foreign_resource","Resource does not belong to this isolated run");
}
function validateResources(s:LabState,r:Resources){
  const spec=labCompose(s),services=spec.services as Record<string,any>,seen=new Set<string>();
  const mounts:Record<string,[string,string]>={"immich-server":[s.project+"_library","/data"],"immich-machine-learning":[s.project+"_models","/cache"],redis:[s.project+"_redis","/data"],database:[s.project+"_database","/var/lib/postgresql/data"]};
  for(const c of r.containers){
    labels(s,c.Config?.Labels);const service=c.Config.Labels["com.docker.compose.service"];
    if(!Object.hasOwn(services,service)||seen.has(service)||typeof c.Id!=="string"||!/^[a-f0-9]{64}$/.test(c.Id)||
      String(c.Config.Image).replace(/^docker.io\//,"")!==services[service].image.replace(/^docker.io\//,"")||c.HostConfig?.NetworkMode==="host"||c.HostConfig?.Privileged===true||c.HostConfig?.PidMode==="host")fail("lab_resources","Unexpected laboratory container");
    seen.add(service);
    const expected=mounts[service]!;
    if(!Array.isArray(c.Mounts)||c.Mounts.length!==1||c.Mounts[0].Type!=="volume"||c.Mounts[0].Name!==expected[0]||c.Mounts[0].Destination!==expected[1])
      fail("lab_mounts","Laboratory containers must use only their own named data volumes");
    const networks=Object.keys(c.NetworkSettings?.Networks ?? {});
    const allowed=services[service].networks.map((n:string)=>s.project+"_"+n);
    if(networks.some(name=>!allowed.includes(name)))fail("lab_network","Laboratory container joined an unexpected network");
    for(const [target,bindings] of Object.entries<any>(c.NetworkSettings?.Ports ?? {}))if(bindings?.length){
      if(service!=="immich-server"||target!=="2283/tcp"||bindings.length!==1||bindings[0].HostIp!=="127.0.0.1"||bindings[0].HostPort!==String(s.port))
        fail("lab_port","Laboratory endpoint is not the expected loopback binding");
    }
  }
  if(new Set(r.volumes.map(v=>v.Name)).size!==r.volumes.length||new Set(r.networks.map(n=>n.Name)).size!==r.networks.length)fail("lab_resources","Duplicate laboratory resource");
  for(const v of r.volumes){labels(s,v.Labels);if(!volumeNames(s).includes(v.Name)||v.Driver!=="local"||Object.keys(v.Options ?? {}).length)fail("lab_resources","Unexpected laboratory volume");}
  for(const n of r.networks){labels(s,n.Labels);if(typeof n.Id!=="string"||!/^[a-f0-9]{64}$/.test(n.Id)||!networkNames(s).includes(n.Name)||n.Driver!=="bridge"||n.Internal!==(n.Name===s.project+"_isolated")||Object.keys(n.Containers ?? {}).some(id=>!r.containers.some(c=>c.Id===id)))fail("lab_network","Unexpected laboratory network");}
}
function composeArgs(s:LabState){return ["compose","--env-file",join(s.root,".env"),"--project-name",s.project,"--file",join(s.root,"compose.yaml")];}
async function observation(s:LabState,r:Resources,http:typeof fetch,scope:string){
  if(r.containers.length!==4||r.volumes.length!==4||r.networks.length!==2||r.containers.some(c=>!c.State?.Running||c.State.Health?.Status!=="healthy"||Object.keys(c.NetworkSettings?.Networks ?? {}).sort().join(",")!==(labCompose(s).services as Record<string,any>)[c.Config.Labels["com.docker.compose.service"]].networks.map((n:string)=>s.project+"_"+n).sort().join(",")))
    fail("lab_not_ready","All four isolated services must be running and healthy");
  const server=r.containers.find(c=>c.Config.Labels["com.docker.compose.service"]==="immich-server");
  const binding=server.NetworkSettings?.Ports?.["2283/tcp"];
  if(!binding||binding.length!==1||binding[0].HostIp!=="127.0.0.1"||binding[0].HostPort!==String(s.port))fail("lab_port","The verified server has no matching loopback endpoint");
  const endpoint="http://127.0.0.1:"+s.port+"/api",response=await http(endpoint+"/server/version",{redirect:"manual",signal:AbortSignal.timeout(5000)});
  if(response.status!==200){await response.body?.cancel();fail("lab_version","The isolated version endpoint is unavailable");}
  const reader=response.body?.getReader() ?? fail("lab_version","Version response is missing");
  let count=0;const chunks:Uint8Array[]=[];
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.length;if(count>16384)fail("lab_version","Version response exceeds its limit");chunks.push(chunk.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{
    const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
    validator(operation("getServerVersion").definition.responses["200"].content["application/json"].schema,registry.schemas)(value);
    if(value.major!==3||value.minor!==3||value.patch!==5||value.prerelease!==null)fail("lab_version","Isolated server must be exactly Immich 3.3.5");
  }catch{fail("lab_version","The isolated version response must match stable Immich 3.3.5");}
  return {state:"running",manifest_version:s.version,image_reference_policy:imagePolicy(s),configured_images_pinned:s.version===2,execution_scope:scope,project:s.project,endpoint,immich_version:"3.3.5",engine_id:s.engine_id,
    containers:r.containers.map(c=>({service:c.Config.Labels["com.docker.compose.service"],id:c.Id,image:c.Config.Image,image_id:c.Image})),
    backend_version_checked:true,api_integration_completed:false,full_acceptance:false};
}
function executionScope(s:LabState,options:LabOptions){
  return s.harness_used||options.docker||options.http?"harness_only":"docker_observation";
}
async function usingHTTP<T>(s:LabState,options:LabOptions,work:(http:typeof fetch)=>Promise<T>){
  const direct=options.http?undefined:new Upstream("http://127.0.0.1:"+s.port+"/api",{concurrency:1,connectTimeoutMs:5000,idleTimeoutMs:15000,reuseConnections:false});
  try{return await work(options.http ?? direct!.fetch);}finally{await direct?.close();}
}
export interface RunningLab {
  state:Readonly<LabState>;
  observation:Awaited<ReturnType<typeof observation>>;
  http:typeof fetch;
}
export async function withRunningLab<T>(directory:string,work:(lab:RunningLab)=>Promise<T>,options:LabOptions={}){
  const docker=options.docker ?? localDockerRunner();
  return owned(directory,true,async(s,key)=>{
    if(!s.engine_id||!s.start_requested||s.destroyed||s.delete_requested)fail("lab_not_started","The isolated run is not active");
    await engine(s,docker);const current=await resources(s,docker);
    if((options.docker||options.http)&&!s.harness_used){s.harness_used=true;await save(s,key);}
    return usingHTTP(s,options,async http=>{
      const observed=await observation(s,current,http,executionScope(s,options));
      return work({state:Object.freeze(structuredClone(s)),observation:observed,http});
    });
  });
}
export async function upLab(directory:string,options:LabOptions={}){
  const docker=options.docker ?? localDockerRunner();
  return owned(directory,true,async(s,key)=>{
    if(s.destroyed||s.delete_requested)fail("lab_destroyed","Prepare a new run after deleting laboratory volumes");
    const daemon=await engine(s,docker),before=await resources(s,docker);
    if(!s.start_requested&&(before.containers.length||before.volumes.length||before.networks.length))fail("lab_not_fresh","A new run cannot adopt existing resources");
    await docker([...composeArgs(s),"config","--quiet"]);s.engine_id=daemon;s.start_requested=true;
    if(options.docker||options.http)s.harness_used=true;await save(s,key);
    await docker([...composeArgs(s),"up","-d","--wait","--wait-timeout","300","--quiet-pull"],900000);
    const current=await resources(s,docker);
    return usingHTTP(s,options,http=>observation(s,current,http,executionScope(s,options)));
  });
}
export async function checkLab(directory:string,options:LabOptions={}){
  return withRunningLab(directory,async lab=>lab.observation,options);
}
export async function downLab(directory:string,deleteVolumes=false,options:LabOptions={}){
  const docker=options.docker ?? localDockerRunner();
  return owned(directory,false,async(s,key)=>{
    const daemon=await engine(s,docker),before=await resources(s,docker);
    const remaining=before.containers.length||before.volumes.length||before.networks.length;
    if(s.destroyed&&!remaining)return {state:"destroyed",already_destroyed:true,project:s.project,execution_scope:executionScope(s,options)};
    if(s.delete_requested&&!deleteVolumes)fail("lab_deletion_pending","Repeat down with explicit volume deletion to finish the recorded teardown");
    if(!s.engine_id&&remaining)fail("lab_not_fresh","Cannot adopt resources for cleanup");
    s.engine_id=daemon;if(options.docker)s.harness_used=true;if(deleteVolumes)s.delete_requested=true;await save(s,key);
    for(const c of before.containers){
      const fresh=JSON.parse(await docker(["inspect","--type","container",c.Id]));validateResources(s,{containers:fresh,volumes:[],networks:[]});
      if(fresh[0].State?.Running)await docker(["stop","--time","45",c.Id],120000);
      await docker(["rm",c.Id]);
    }
    for(const n of before.networks){
      const fresh=JSON.parse(await docker(["network","inspect",n.Id]));validateResources(s,{containers:[],volumes:[],networks:fresh});await docker(["network","rm",n.Id]);
    }
    if(deleteVolumes)for(const v of before.volumes){
      const fresh=JSON.parse(await docker(["volume","inspect",v.Name]));validateResources(s,{containers:[],volumes:fresh,networks:[]});await docker(["volume","rm",v.Name]);
    }
    const after=await resources(s,docker);
    if(after.containers.length||after.networks.length||deleteVolumes&&after.volumes.length)fail("lab_cleanup_incomplete","Owned resources remain after teardown");
    if(deleteVolumes){s.destroyed=true;await save(s,key);}
    return {state:deleteVolumes?"destroyed":"stopped",project:s.project,retained_volumes:after.volumes.map(v=>v.Name),host_files_removed:false,
      execution_scope:executionScope(s,options)};
  });
}
