import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,mkdir,writeFile,rm,symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/app.js";
import { serve } from "../src/http.js";
import { config } from "../src/config.js";
test("deployment configuration isolates origin traffic, writable paths and secrets without root privileges",async()=>{
  const compose=JSON.parse(await readFile("compose.yaml","utf8"));
  for(const service of Object.values<any>(compose.services)){
    assert.match(service.user,/^[1-9][0-9]*:[1-9][0-9]*$/);assert.equal(service.read_only,true);assert.ok(service.cap_drop.includes("ALL"));
    assert.ok(service.security_opt.includes("no-new-privileges:true"));assert.equal(service.privileged,undefined);assert.equal(service.ports,undefined);
    assert.notEqual(service.network_mode,"host");assert.notEqual(service.pid,"host");
    for(const mount of service.volumes ?? [])assert.ok(mount.target==="/data"&&mount.type==="bind"&&mount.bind.create_host_path===false);
    for(const path of service.tmpfs ?? [])assert.match(path,/^\/tmp:.*noexec.*nosuid/);
    assert.ok((service.secrets ?? []).length===1);
  }
  const mcp=compose.services.mcp,connector=compose.services.cloudflared;
  assert.equal(compose.networks.tunnel.internal,true);assert.ok(mcp.networks.includes("tunnel"));assert.ok(connector.networks.includes("tunnel"));
  assert.ok(mcp.networks.includes("immich"));assert.ok(!connector.networks.includes("immich"));
  assert.ok(mcp.networks.includes("mcp_egress"));assert.ok(connector.networks.includes("connector_egress"));
  assert.equal(connector.depends_on.mcp.condition,"service_healthy");assert.ok(connector.command.includes("--token-file"));
  assert.equal(mcp.environment.VAULT_MASTER_KEY_FILE,"/run/secrets/vault_master_key");assert.equal(mcp.environment.STORAGE_PATH,"/data");
  assert.ok(!JSON.stringify(mcp).includes("tunnel_token"));assert.ok(!JSON.stringify(connector).includes("vault_master_key"));
  assert.ok(!JSON.stringify(compose).includes("docker.sock"));
  const dockerfile=await readFile("Dockerfile","utf8"),runtime=dockerfile.split("AS runtime")[1]!;
  assert.match(dockerfile,/ARG NODE_IMAGE=node:24\.\d+\.\d+-bookworm-slim/);assert.ok(!dockerfile.includes(":latest"));
  assert.match(dockerfile,/install --prod --frozen-lockfile --ignore-scripts/);assert.match(runtime,/USER [1-9][0-9]*:[1-9][0-9]*/);
  assert.ok(runtime.includes('healthcheck.js","live"'));assert.ok(runtime.includes("COPY --from=dependencies"));
  assert.ok(!runtime.includes("COPY . ."));assert.ok(!runtime.includes("pnpm install"));
});
async function healthChild(port:number,mode:string){
  const child=spawn(process.execPath,["dist/scripts/healthcheck.js",mode],{cwd:process.cwd(),env:{...process.env,MCP_LISTEN_PORT:String(port)},windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";child.stdout!.on("data",chunk=>{stdout+=chunk.toString();});child.stderr!.on("data",chunk=>{stderr+=chunk.toString();});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});return {code,stdout,stderr};
}
test("the actual container healthcheck keeps liveness healthy through an upstream outage and reports readiness separately",async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-container-health-"));let available=true;
  const app=await Application.create({directory:join(root,"data"),masterKey:randomBytes(32),upstream:"http://immich/api",publicOrigin:"https://mcp.example",
    issuer:"https://team.cloudflareaccess.com",audience:"app",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",host:"127.0.0.1",port:0},
    {http:(async()=>available?Response.json({major:3,minor:3,patch:5,prerelease:null}):new Response(null,{status:503})) as typeof fetch,
      versionIntervalMs:0,cleanupIntervalMs:0,localIntervalMs:0});
  const http=await serve(app),port=(http.address as {port:number}).port;
  try{
    assert.equal((await healthChild(port,"live")).code,0);assert.equal((await healthChild(port,"ready")).code,0);
    available=false;await app.checkVersion();const live=await healthChild(port,"live"),ready=await healthChild(port,"ready");
    assert.equal(live.code,0,live.stderr);assert.equal(JSON.parse(live.stdout).ok,true);assert.equal(ready.code,1);assert.equal(JSON.parse(ready.stdout).ok,false);
    available=true;await app.checkVersion();assert.equal((await healthChild(port,"ready")).code,0);assert.equal((await healthChild(port,"invalid")).code,1);
  }finally{await http.close();await rm(root,{recursive:true,force:true});}
});
test("configuration resolves data aliases and rejects master keys stored inside the actual data directory",async()=>{
  const root=await mkdtemp(join(tmpdir(),"immich-key-separation-")),data=join(root,"data"),alias=join(root,"alias");await mkdir(data);
  const key=join(data,"master.key");await writeFile(key,randomBytes(32));
  const env={IMMICH_BASE_URL:"http://immich/api",MCP_PUBLIC_BASE_URL:"https://mcp.example",ACCESS_ISSUER:"https://team.cloudflareaccess.com",ACCESS_AUDIENCE:"app",
    ACCESS_JWKS_URL:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",VAULT_MASTER_KEY_FILE:key,STORAGE_PATH:data};
  try{
    await assert.rejects(config(env),/separate/);await symlink(data,alias,"junction");await assert.rejects(config({...env,STORAGE_PATH:alias}),/separate/);
    const separate=join(root,"private.key");await writeFile(separate,randomBytes(32));const settings=await config({...env,STORAGE_PATH:alias,VAULT_MASTER_KEY_FILE:separate});
    assert.equal(settings.directory,data);assert.equal(settings.masterKeyFile,separate);settings.masterKey.fill(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
