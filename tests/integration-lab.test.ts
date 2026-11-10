import { state,setup,fakeDocker,fakeHttp } from "./lab-harness.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile,rm,cp } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { prepareLab,upLab,checkLab,downLab,localDockerRunner,LAB_SOURCE,LAB_IMAGES,type DockerRunner } from "../src/integration-lab.js";
import { integrationCommand } from "../scripts/integration.js";
import { BridgeError } from "../src/types.js";

const label="io.immich-mcp.integration.run";
const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
function destructive(args:string[]){return args[0]==="stop"||args[0]==="rm"||args[1]==="rm"||args[0]==="compose"&&args.includes("up");}
function child(args:string[],env:NodeJS.ProcessEnv=process.env){
  const processChild=spawn(process.execPath,args,{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";processChild.stdout!.on("data",x=>{stdout+=x.toString();});processChild.stderr!.on("data",x=>{stderr+=x.toString();});
  return new Promise<{code:number|null;stdout:string;stderr:string}>((accept,reject)=>{
    processChild.once("error",reject);processChild.once("close",code=>accept({code,stdout,stderr}));
  });
}

test("laboratory preparation fixes versions, private files, new volume names and a loopback port without executing Docker",async()=>{
  const {base,root}=await setup();
  try{
    const spec=JSON.parse(await readFile(join(root,"compose.yaml"),"utf8")),s=await state(root),env=await readFile(join(root,".env"),"utf8");
    assert.equal(s.source_commit,LAB_SOURCE);assert.equal(spec.services["immich-server"].image,LAB_IMAGES.server);assert.equal(spec.services["immich-machine-learning"].image,LAB_IMAGES.machineLearning);
    assert.match(spec.services.database.image,/@sha256:[0-9a-f]{64}$/);assert.match(spec.services.redis.image,/@sha256:[0-9a-f]{64}$/);
    assert.match(env,/^DB_PASSWORD=[0-9a-f]{64}\n$/);assert.equal((await readFile(join(root,".run.key"))).length,32);assert.equal((await readFile(join(root,".vault.key"))).length,32);
    assert.equal(s.start_requested,undefined);assert.equal(s.engine_id,undefined);
    assert.equal(spec.services["immich-server"].ports[0].host_ip,"127.0.0.1");assert.equal(spec.networks.isolated.internal,true);
    for(const service of Object.values<any>(spec.services)){assert.equal(service.restart,"no");assert.ok(service.volumes.every((v:string)=>!/^[./\\]|^[A-Z]:/.test(v)));assert.equal(service.privileged,undefined);}
    for(const volume of Object.values<any>(spec.volumes)){assert.ok(volume.name.startsWith(s.project+"_"));assert.equal(volume.external,undefined);assert.equal(volume.driver_opts,undefined);}
    assert.ok(!JSON.stringify(spec).includes("docker.sock"));assert.ok(!JSON.stringify(s).includes(env.split("=")[1]!.trim()));
    const second=await prepareLab(join(base,"other"));assert.notEqual(second.project,s.project);assert.equal(second.execution_scope,"preparation_only");assert.equal(second.docker_executed,false);
    await assert.rejects(prepareLab(root),isCode("destination_exists"));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("laboratory preparation rejects private paths inside the checkout and invalid ports",async()=>{
  const base=await mkdtemp(join(tmpdir(),"immich-lab-path-"));
  try{
    await assert.rejects(prepareLab(resolve(".never-create-immich-run")),isCode("lab_path"));
    for(const port of [0,80,65536,1.5,NaN])await assert.rejects(prepareLab(join(base,"bad"),port),isCode("lab_path"));
    await assert.rejects(prepareLab("relative"),isCode("lab_path"));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("authenticated run state and original physical root are checked before invoking Docker",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root);
  try{
    const file=join(root,"run.json"),original=await readFile(file,"utf8"),envelope=JSON.parse(original),value=JSON.parse(envelope.payload);
    value.port=9999;envelope.payload=JSON.stringify(value);await writeFile(file,JSON.stringify(envelope));
    await assert.rejects(upLab(root,{docker:runner}),isCode("lab_authentication"));assert.equal(fake.calls.length,0);
    await writeFile(file,original);const copy=join(base,"copy");await cp(root,copy,{recursive:true});
    await assert.rejects(upLab(copy,{docker:runner}),isCode("lab_manifest"));assert.equal(fake.calls.length,0);
    await writeFile(join(root,".run.key"),Buffer.alloc(32));await assert.rejects(downLab(root,false,{docker:runner}),isCode("lab_authentication"));assert.equal(fake.calls.length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("up and check observe four healthy services and exact version but never certify API integration",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http,calls}=fakeHttp(root);
  try{
    const started=await upLab(root,{docker:runner,http}),checked=await checkLab(root,{docker:runner,http});
    assert.equal(started.state,"running");assert.equal(started.containers.length,4);assert.equal(checked.backend_version_checked,true);
    assert.equal(checked.execution_scope,"harness_only");assert.equal(checked.api_integration_completed,false);assert.equal(checked.full_acceptance,false);assert.equal(calls.length,2);
    const s=await state(root);assert.equal(s.engine_id,fake.engine);assert.equal(s.start_requested,true);
    const env=await readFile(join(root,".env"),"utf8"),secret=env.split("=")[1]!.trim();
    assert.ok(!JSON.stringify(fake.calls).includes(secret));assert.ok(!JSON.stringify(started).includes(secret));assert.ok(!JSON.stringify(checked).includes(secret));
    const up=fake.calls.find(a=>a[0]==="compose"&&a.includes("up"))!;assert.ok(up.includes("--wait"));assert.ok(up.includes("--quiet-pull"));
    for(const call of fake.calls.filter(a=>a.includes("--filter")))assert.equal(call.at(-1),"label=com.docker.compose.project="+s.project);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("unchanged run configuration is mandatory for execution; owned teardown remains possible without the env file",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});const original=await readFile(join(root,"compose.yaml"));
    await writeFile(join(root,"compose.yaml"),"{}");fake.calls.length=0;
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_changed"));assert.equal(fake.calls.length,0);
    await writeFile(join(root,"compose.yaml"),original);await rm(join(root,".env"));
    const stopped=await downLab(root,false,{docker:runner});assert.equal(stopped.state,"stopped");assert.equal(fake.containers.length,0);assert.equal(fake.volumes.length,4);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a changed Docker daemon is rejected before HTTP and all destructive operations",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http,calls}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});fake.engine="different-engine";fake.calls.length=0;calls.length=0;
    await assert.rejects(checkLab(root,{docker:runner,http}),isCode("lab_engine"));
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_engine"));
    await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_engine"));
    assert.equal(calls.length,0);assert.ok(!fake.calls.some(destructive));assert.equal((await state(root)).delete_requested,undefined);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a new run never adopts resources even when a foreign process copies its project labels",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    const s=await state(root);fake.volumes=[{Name:s.project+"_library",Driver:"local",Options:null,Labels:{[label]:s.id,"com.docker.compose.project":s.project}}];
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_not_fresh"));assert.ok(!fake.calls.some(destructive));
    fake.volumes[0].Labels[label]="foreign";fake.calls.length=0;
    await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_foreign_resource"));assert.ok(!fake.calls.some(destructive));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("teardown rejects unrelated containers, binds, public ports, networks and bind-backed volumes",async t=>{
  const cases:[string,(fake:ReturnType<typeof fakeDocker>["fake"])=>void,string][]=[
    ["owner label",f=>{f.containers[0].Config.Labels[label]="foreign";},"lab_foreign_resource"],
    ["unexpected image",f=>{f.containers[0].Config.Image="ghcr.io/immich-app/immich-server:latest";},"lab_resources"],
    ["host bind",f=>{f.containers[0].Mounts[0]={Type:"bind",Source:"/real/photos",Destination:"/data"};},"lab_mounts"],
    ["host port",f=>{f.containers[0].NetworkSettings.Ports["2283/tcp"][0].HostIp="0.0.0.0";},"lab_port"],
    ["foreign network",f=>{f.containers[0].NetworkSettings.Networks.production={};},"lab_network"],
    ["bind-backed volume",f=>{f.volumes[0].Options={type:"none",o:"bind",device:"/real/photos"};},"lab_resources"],
    ["network with foreign member",f=>{f.networks[0].Containers["f".repeat(64)]={Name:"foreign"};},"lab_network"],
    ["privileged container",f=>{f.containers[0].HostConfig.Privileged=true;},"lab_resources"]
  ];
  for(const [name,mutate,code] of cases)await t.test(name,async()=>{
    const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http,calls}=fakeHttp(root);
    try{
      await upLab(root,{docker:runner,http});mutate(fake);fake.calls.length=0;calls.length=0;
      await assert.rejects(downLab(root,true,{docker:runner}),isCode(code));assert.ok(!fake.calls.some(destructive));assert.equal(calls.length,0);
      assert.equal((await state(root)).delete_requested,undefined);
    }finally{await rm(base,{recursive:true,force:true});}
  });
});

test("default down keeps all named volumes for restart; explicit deletion only removes this run's volumes",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});const names=fake.volumes.map(v=>v.Name).sort();
    const stopped=await downLab(root,false,{docker:runner});assert.equal(stopped.retained_volumes?.length,4);assert.equal(stopped.host_files_removed,false);
    assert.equal(fake.containers.length,0);assert.equal(fake.networks.length,0);assert.deepEqual(fake.volumes.map(v=>v.Name).sort(),names);
    await assert.rejects(checkLab(root,{docker:runner,http}),isCode("lab_not_ready"));await upLab(root,{docker:runner,http});
    const destroyed=await downLab(root,true,{docker:runner});assert.equal(destroyed.state,"destroyed");assert.equal(fake.volumes.length,0);assert.equal(destroyed.execution_scope,"harness_only");
    const s=await state(root);assert.equal(s.destroyed,true);assert.equal(s.delete_requested,true);
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_destroyed"));assert.equal((await downLab(root,true,{docker:runner})).already_destroyed,true);
    assert.ok((await readFile(join(root,".run.key"))).length===32);assert.ok(fake.calls.every(a=>!a.includes("--force")&&!a.includes("--volumes")));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("partial up has a durable owner intent and resumes only the same engine's isolated infrastructure",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    fake.upFailure=true;await assert.rejects(upLab(root,{docker:runner,http}),isCode("docker_failed"));
    const s=await state(root);assert.equal(s.start_requested,true);assert.equal(s.engine_id,fake.engine);assert.equal(fake.containers.length,4);
    const result=await upLab(root,{docker:runner,http});assert.equal(result.state,"running");assert.equal(result.full_acceptance,false);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("partial explicit deletion prevents restart and can finish teardown without rerunning mutations",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});fake.removeFailure=true;
    await assert.rejects(downLab(root,true,{docker:runner}),isCode("docker_failed"));assert.equal((await state(root)).delete_requested,true);
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_destroyed"));
    await assert.rejects(downLab(root,false,{docker:runner}),isCode("lab_deletion_pending"));
    await downLab(root,true,{docker:runner});assert.equal(fake.containers.length,0);assert.equal(fake.volumes.length,0);assert.equal((await state(root)).destroyed,true);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("ownership is inspected again immediately before stopping a container",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});fake.calls.length=0;
    fake.before=args=>{if(args[0]==="inspect"&&args.length===4)fake.containers.find(c=>c.Id===args[3]).Config.Labels[label]="changed-after-inventory";};
    await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_foreign_resource"));assert.ok(!fake.calls.some(destructive));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("unhealthy services and wrong or oversized version replies never become a ready observation",async t=>{
  for(const [name,value] of [["wrong version",{major:3,minor:3,patch:6,prerelease:null}],["prerelease",{major:3,minor:3,patch:5,prerelease:"rc.1"}],
    ["oversized",{major:3,minor:3,patch:5,prerelease:null,padding:"x".repeat(17000)}]] as const)await t.test(name,async()=>{
      const {base,root}=await setup(),{runner}=fakeDocker(root),{http}=fakeHttp(root,value);
      try{await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_version"));assert.equal((await state(root)).destroyed,undefined);}
      finally{await rm(base,{recursive:true,force:true});}
    });
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http,calls}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});calls.length=0;fake.containers[0].State.Health.Status="unhealthy";
    await assert.rejects(checkLab(root,{docker:runner,http}),isCode("lab_not_ready"));assert.equal(calls.length,0);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("local Docker selection is pinned, honors explicit contexts, and rejects remote endpoints before any engine call",async()=>{
  for(const host of ["unix:///var/run/docker.sock","npipe:////./pipe/dockerDesktopLinuxEngine"]){
    const calls:string[][]=[];let endpoint=host;
    const invoke:DockerRunner=async args=>{calls.push([...args]);return args[0]==="context"?JSON.stringify(endpoint):"ok";};
    const docker=localDockerRunner({DOCKER_CONTEXT:"chosen",DOCKER_HOST:"tcp://ignored:2375"},invoke);
    await docker(["info"]);endpoint="ssh://foreign";await docker(["ps"]);
    assert.equal(calls.filter(a=>a[0]==="context").length,1);assert.equal(calls[0]![2],"chosen");
    assert.deepEqual(calls[1],["--host",host,"info"]);assert.deepEqual(calls[2],["--host",host,"ps"]);
  }
  for(const host of ["ssh://foreign","tcp://127.0.0.1:2375","http://remote","unix:///sock?bad","unix:///sock\n"]){
    const calls:string[][]=[];const docker=localDockerRunner({},async args=>{calls.push(args);return JSON.stringify(host);});
    await assert.rejects(docker(["info"]),isCode("lab_remote_daemon"));assert.equal(calls.length,1);
  }
  const calls:string[][]=[],docker=localDockerRunner({DOCKER_HOST:"unix:///explicit.sock"},async args=>{calls.push(args);return "ok";});
  await docker(["info"]);assert.deepEqual(calls,[["--host","unix:///explicit.sock","info"]]);
});

test("the actual CLI prepares private state and reports missing Docker without secret, stack or endpoint disclosure",async()=>{
  const base=await mkdtemp(join(tmpdir(),"immich-lab-cli-")),root=join(base,"run");
  try{
    const prepared=await child(["dist/scripts/integration.js","prepare","--directory",root]);assert.equal(prepared.code,0,prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).execution_scope,"preparation_only");
    const absent=await child(["dist/scripts/integration.js","up","--directory",root],{...process.env,PATH:"",DOCKER_CONTEXT:"",DOCKER_HOST:""});
    assert.equal(absent.code,1);assert.equal(absent.stdout,"");assert.equal(JSON.parse(absent.stderr.trim().split("\n").at(-1)!).error.code,"docker_unavailable");
    assert.equal((await state(root)).start_requested,undefined);const secret=(await readFile(join(root,".env"),"utf8")).split("=")[1]!.trim();assert.ok(!absent.stderr.includes(secret));
    assert.ok(!absent.stderr.includes(" at "));assert.ok(!absent.stderr.includes(root));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("a live owner excludes another process rather than accepting a competing laboratory command",async()=>{
  const {base,root}=await setup(),{runner}=fakeDocker(root),{http}=fakeHttp(root);
  let release!:()=>void,started!:()=>void;
  const waiting=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const blocked:DockerRunner=async args=>{if(args[0]==="info"){started();await waiting;}return runner(args);};
  const active=upLab(root,{docker:blocked,http});
  try{
    await entered;
    const other=await child(["dist/scripts/integration.js","up","--directory",root],{...process.env,PATH:"",DOCKER_CONTEXT:"",DOCKER_HOST:""});
    assert.equal(other.code,1);assert.equal(JSON.parse(other.stderr.trim().split("\n").at(-1)!).error.code,"integration_failed");
    release();assert.equal((await active).state,"running");
  }finally{release();await active.catch(()=>{});await rm(base,{recursive:true,force:true});}
});

test("CLI rejects irrelevant options and never accepts an arbitrary upstream URL",async()=>{
  for(const args of [["prepare","--directory","relative","--port","12.5"],["up","--directory","relative","--delete-volumes"],
    ["check","--directory","relative","--port","2283"],["unknown","--directory","relative"],["down","--directory","relative","--url","http://production/api"]])
    await assert.rejects(integrationCommand(args));
});

test("teardown rechecks a previously destroyed run and can reclaim late owned resources",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});
    const late=JSON.parse(JSON.stringify({containers:fake.containers,volumes:fake.volumes,networks:fake.networks}));
    await downLab(root,true,{docker:runner});
    Object.assign(fake,late);fake.calls.length=0;
    await assert.rejects(downLab(root,false,{docker:runner}),isCode("lab_deletion_pending"));assert.ok(!fake.calls.some(destructive));
    await downLab(root,true,{docker:runner});assert.equal(fake.containers.length,0);assert.equal(fake.networks.length,0);assert.equal(fake.volumes.length,0);
    assert.equal((await downLab(root,true,{docker:runner})).already_destroyed,true);
  }finally{await rm(base,{recursive:true,force:true});}
});
