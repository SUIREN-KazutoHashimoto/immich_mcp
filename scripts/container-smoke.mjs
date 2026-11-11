// Docker/Linux smoke only. The upstream fixture is synthetic, not real Immich.
import assert from "node:assert/strict";
import {version as containerVersion} from "./container-channels.ts";
import {execFileSync,spawnSync} from "node:child_process";
import {containerSmokeEnvironment} from "./container-smoke-config.ts";
import {mkdtemp,writeFile,chmod,mkdir,rm} from "node:fs/promises";
import {randomBytes,randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join,resolve,dirname,sep} from "node:path";
const image=process.argv[2],report=process.argv[3];
assert.ok(image&&/^[a-z0-9][a-z0-9._:/@-]*$/.test(image),"Pass an explicit image tag and JSON report path");
assert.ok(report,"Pass a JSON report path");
const id=randomUUID(),prefix="immich-mcp-smoke-"+id,label="immich-mcp.smoke-run",network=prefix+"-net",volume=prefix+"-data",
  stub=prefix+"-upstream",mcp=prefix+"-app",init=prefix+"-init",resources=[];
const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,"immich-mcp-docker-"));
assert.ok(resolve(root).startsWith(parent+sep)&&!root.includes(","));
const key=join(root,"vault.key");
const docker=(args)=>execFileSync("docker",args,{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:120000}).trim();
const json=(args)=>JSON.parse(docker(args));
const plan=(kind,name)=>{resources.push({kind,name});return name;};
async function ready(){
  for(let attempt=0;attempt<40;attempt++){
    try{const d=JSON.parse(docker(["exec",mcp,"node","dist/scripts/healthcheck.js","ready"]));if(d.ok===true)return;}
    catch{}
    const d=json(["container","inspect",mcp])[0];
    assert.equal(d.State.Running,true,"MCP container exited before readiness");
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error("Container readiness did not succeed within the bounded smoke check");
}
async function cleanup(){
  const errors=[];
  for(const {kind,name}of resources.reverse()){
    let data;
    try{data=json([kind,"inspect",name])[0];}catch{continue;}
    const labels=kind==="container"?data.Config.Labels:data.Labels;
    if(labels?.[label]!==id){errors.push("Refused to remove foreign "+kind);continue;}
    try{docker([kind,"rm",...(kind==="container"?["--force"]:[]),name]);}catch{errors.push("Could not remove owned "+kind);}
  }
  await rm(root,{recursive:true,force:true});
  assert.deepEqual(errors,[],"Owned smoke resources were not fully removed");
}
let result,failure;
try{
  await writeFile(key,randomBytes(32),{flag:"wx",mode:0o600});
  // Synthetic test key; its host parent remains0700 and the container bind is read-only.
  await chmod(root,0o700);await chmod(key,0o644);
  const imageInfo=json(["image","inspect",image])[0],version=imageInfo.Config.Labels?.["org.opencontainers.image.version"];
  assert.ok(containerVersion(version),"Container label must be a stable or beta version");
  assert.equal(imageInfo.Config.User,"1000:1000");assert.equal(imageInfo.Os,"linux");
  assert.ok(imageInfo.Config.Healthcheck.Test.includes("dist/scripts/healthcheck.js"));
  docker(["network","create","--label",label+"="+id,plan("network",network)]);
  docker(["volume","create","--label",label+"="+id,plan("volume",volume)]);
  docker(["run","--rm","--name",plan("container",init),"--label",label+"="+id,"--network","none","--read-only","--user","0:0",
    "--mount","type=volume,source="+volume+",target=/data","--entrypoint","node",image,"-e",
    "const fs=require('node:fs');fs.chownSync('/data',1000,1000);fs.chmodSync('/data',0o700)"]);
  const fixture="require('node:http').createServer((q,s)=>{s.writeHead(q.url==='/api/server/version'?200:404,{'content-type':'application/json'});s.end(q.url==='/api/server/version'?JSON.stringify({major:3,minor:3,patch:5,prerelease:null}):'{}')}).listen(2283,'0.0.0.0')";
  docker(["run","--detach","--name",plan("container",stub),"--label",label+"="+id,"--network",network,"--network-alias","immich-smoke",
    "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges:true","--user","1000:1000","--entrypoint","node",image,"-e",fixture]);
  const env=containerSmokeEnvironment;
  const composeData=join(root,"compose-data"),runtimeEnv=join(root,"runtime.env"),stackEnv=join(root,"stack.env");
  await mkdir(composeData);
  await writeFile(runtimeEnv,Object.entries(env).map(([k,v])=>k+"="+v).join("\n")+"\n",{flag:"wx",mode:0o600});
  await writeFile(stackEnv,["MCP_IMAGE="+image,"MCP_ENV_FILE="+runtimeEnv,"MCP_DATA_DIR="+composeData,
    "MCP_MASTER_KEY_FILE="+key,"IMMICH_NETWORK="+network,"MCP_TEST_PORT=3000"].join("\n")+"\n",{flag:"wx",mode:0o600});
  docker(["compose","--env-file",stackEnv,"-f","compose.beta.yaml","config","--quiet"]);
  docker(["run","--detach","--init","--name",plan("container",mcp),"--label",label+"="+id,"--network",network,
    "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges:true","--user","1000:1000",
    "--tmpfs","/tmp:rw,noexec,nosuid,size=134217728,uid=1000,gid=1000,mode=1770",
    "--mount","type=volume,source="+volume+",target=/data","--mount","type=bind,source="+key+",target=/run/secrets/vault_master_key,readonly",
    ...Object.entries(env).flatMap(([k,v])=>["--env",k+"="+v]),image]);
  await ready();
  assert.equal(JSON.parse(docker(["exec",mcp,"node","dist/scripts/healthcheck.js","live"])).ok,true);
  const running=json(["container","inspect",mcp])[0];
  assert.equal(running.HostConfig.ReadonlyRootfs,true);assert.equal(running.Config.User,"1000:1000");
  assert.deepEqual(running.HostConfig.CapDrop,["ALL"]);
  const store=running.Mounts.find(x=>x.Destination==="/data");assert.equal(store.Name,volume);
  assert.equal(running.Mounts.find(x=>x.Destination==="/run/secrets/vault_master_key").RW,false);
  const imageContent=json(["exec",mcp,"node","--input-type=module","-e","import {mkdtemp,rm} from \"node:fs/promises\";\nimport {tmpdir} from \"node:os\";\nimport {join} from \"node:path\";\nimport {randomBytes} from \"node:crypto\";\nimport assert from \"node:assert/strict\";\nimport sharp from \"sharp\";\nimport {Application} from \"./dist/src/app.js\";\nimport {Images} from \"./dist/src/images.js\";\nimport {imageViewerResource,IMAGE_VIEWER_URI,IMAGE_VIEWER_MIME} from \"./dist/src/image-viewer.js\";\nimport {inspectImageResult} from \"./dist/scripts/image-result-check.js\";\nconst dir=await mkdtemp(join(tmpdir(),\"immich-image-smoke-\"));\nlet app;\ntry{\n app=await Application.create({directory:dir,masterKey:randomBytes(32),upstream:\"http://immich-smoke:2283/api\",publicOrigin:\"https://mcp.example.test\",issuer:\"https://access.example.test\",audience:\"smoke\",jwksUrl:\"https://access.example.test/cdn-cgi/access/certs\",host:\"127.0.0.1\",port:0},{versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0});\n const vault=app.vault,images=new Images(vault,app.control,()=>{});\n const info=await app.tools.invoke(\"unregistered-smoke\",\"immich_get_server_info\",{});\n assert.equal(info.server.name,\"immich-mcp\");assert.equal(info.readiness.ready,true);assert.equal(info.capabilities.tool_count,11);assert.equal(info.immich.observed_version,\"3.3.5\");\n vault.replaceBinding(\"synthetic\",\"synthetic-fixture-key\",\"11111111-1111-4111-8111-111111111111\",0);\n const original=await sharp({create:{width:16,height:8,channels:3,background:\"red\"}}).jpeg().withExif({IFD0:{Artist:\"SYNTHETIC-METADATA\"}}).toBuffer();\n const raw=await vault.capture(\"synthetic\",(async function*(){yield original;})(),original.length);\n const ref=vault.put(\"synthetic\",\"result\",{revision:1,display:{operation_id:\"viewAsset\",state:\"completed\",upstream:{status:200,content_type:\"image/jpeg\"}},raw});\n const result=await images.read(\"synthetic\",{result_ref:ref,max_width:8,max_height:8});\n const content=result.content.find(part=>part.type===\"image\");assert.ok(content);\n const meta=await sharp(Buffer.from(content.data,\"base64\")).metadata();\n assert.equal(content.mimeType,\"image/jpeg\");assert.equal(meta.width,8);assert.equal(meta.height,4);assert.equal(meta.exif,undefined);\n const viewer=imageViewerResource();assert.equal(viewer.uri,IMAGE_VIEWER_URI);assert.equal(viewer.mimeType,IMAGE_VIEWER_MIME);assert.ok(viewer.text.includes(\"ui/notifications/tool-result\"));assert.ok(!viewer.text.includes(content.data));assert.deepEqual(result._meta.image_content,content);assert.equal((await inspectImageResult(result)).ok,true);\n console.log(JSON.stringify({mcp_server_info:true,application_version:info.server.version,build_revision:info.server.build_revision,tool_count:info.capabilities.tool_count,private_image_viewer:true,model_image_content:true,mime:content.mimeType,width:meta.width,height:meta.height,metadata_removed:true}));\n}finally{await app?.close();await rm(dir,{recursive:true,force:true});}\n"]);
  assert.equal(imageContent.mcp_server_info,true);assert.equal(imageContent.application_version,version);assert.equal(imageContent.build_revision,imageInfo.Config.Labels?.["org.opencontainers.image.revision"]??null);
  assert.equal(imageContent.model_image_content,true);assert.equal(imageContent.private_image_viewer,true);
  docker(["restart",mcp]);await ready();
  result={format:"immich-mcp-container-smoke",version,observed_at:new Date().toISOString(),source_commit:process.env.GITHUB_SHA??null,
    image:{tag:image,id:imageInfo.Id,os:imageInfo.Os,architecture:imageInfo.Architecture},
    mcp_server_info:true,build_revision:imageContent.build_revision,tool_count:imageContent.tool_count,private_image_viewer:true,model_image_content:true,image_content_mime:imageContent.mime,compose_beta_rendered:true,nonroot_readonly_runtime:true,liveness:true,readiness:true,readiness_after_same_volume_restart:true,owned_resources_cleaned:false,
    evidence_scope:"Real Linux Docker image/startup/storage-key/assets/readiness/restart with synthetic upstream and image fixtures only",
    actual_immich_verified:false,cloudflare_verified:false,chatgpt_verified:false,full_acceptance:false};
}catch(error){
  failure=error;
  for(const name of [mcp,stub])try{
    const inspected=json(["container","inspect",name])[0];
    if(inspected.Config.Labels?.[label]!==id)continue;
    process.stderr.write(JSON.stringify({container:name,state:inspected.State.Status,exit_code:inspected.State.ExitCode})+"\n");
    const log=spawnSync("docker",["logs","--tail","40",name],{encoding:"utf8",windowsHide:true});
    process.stderr.write((log.stdout??"")+(log.stderr??"")+"\n");
  }catch{}
}finally{
  try{await cleanup();}catch(error){failure??=error;}
}
if(failure)throw failure;
result.owned_resources_cleaned=true;
await mkdir(dirname(resolve(report)),{recursive:true});await writeFile(report,JSON.stringify(result,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify(result));
