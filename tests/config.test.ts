import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm,stat,mkdir,unlink,rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../src/config.js";
import { Application } from "../src/app.js";
async function fixture(run:(env:NodeJS.ProcessEnv,dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"immich-config-")),key=join(dir,"master.key");await writeFile(key,randomBytes(32));
  const env={IMMICH_BASE_URL:"http://immich.test/api/",MCP_PUBLIC_BASE_URL:"https://mcp.example.test",ACCESS_ISSUER:"https://team.cloudflareaccess.com",
    ACCESS_AUDIENCE:"app",ACCESS_JWKS_URL:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",VAULT_MASTER_KEY_FILE:key,STORAGE_PATH:join(dir,"objects-store")};
  try{await run(env,dir);}finally{await rm(dir,{recursive:true,force:true});}
}
test("resource settings reject unsafe values and preserve durable database/configuration defaults",()=>fixture(async(env,dir)=>{
  const defaults=await config(env);assert.equal(defaults.upstream,"http://immich.test/api");assert.equal(defaults.inlineResultMaxBytes,131072);
  assert.equal(defaults.databasePath,join(env.STORAGE_PATH!,"vault.sqlite"));assert.equal(defaults.resultTtlMs,3600000);assert.equal(defaults.maxUpstreamConcurrency,8);assert.equal(defaults.upstreamConnectTimeoutMs,10000);assert.equal(defaults.upstreamIdleTimeoutMs,30000);assert.equal(defaults.maxDecodedResultBytes,defaults.maxResultBytes);
  for(const name of ["MAX_UPSTREAM_CONCURRENCY","UPSTREAM_CONNECT_TIMEOUT_MS","UPSTREAM_IDLE_TIMEOUT_MS","MAX_DECODED_RESULT_BYTES","STORAGE_QUOTA_BYTES","GLOBAL_STORAGE_QUOTA_BYTES","MAX_RESULT_BYTES","MAX_UPLOAD_BYTES","INLINE_RESULT_MAX_BYTES","JSON_VALUE_MAX_BYTES","RESULT_TTL_SECONDS","STAGING_TTL_SECONDS","MAX_JOBS_PER_PRINCIPAL"])
    for(const value of ["0","-1","1.5","NaN","Infinity","0x100","9007199254740992"])await assert.rejects(config({...env,[name]:value}));
  await assert.rejects(config({...env,RESULT_TTL_SECONDS:"9007199254741"}));
  await assert.rejects(config({...env,DATABASE_PATH:":memory:"}));
  await assert.rejects(config({...env,MCP_LISTEN_PORT:"65536"}));
  for(const name of ["UPSTREAM_CONNECT_TIMEOUT_MS","UPSTREAM_IDLE_TIMEOUT_MS","MAX_UPSTREAM_CONCURRENCY"])await assert.rejects(config({...env,[name]:"2147483648"}));
  await assert.rejects(config({...env,MAX_RESULT_BYTES:"100",INLINE_RESULT_MAX_BYTES:"101"}));
  const absent=join(dir,"missing.key");await assert.rejects(config({...env,VAULT_MASTER_KEY_FILE:absent}));await assert.rejects(stat(absent),{code:"ENOENT"});
}));
test("application wires size/TTL/job limits and reports cleanup failures through readiness",()=>fixture(async(env,dir)=>{
  const settings=await config({...env,DATABASE_PATH:join(dir,"database","vault.sqlite"),MAX_RESULT_BYTES:"8192",INLINE_RESULT_MAX_BYTES:"256",JSON_VALUE_MAX_BYTES:"2048",RESULT_TTL_SECONDS:"10",STAGING_TTL_SECONDS:"20",MAX_JOBS_PER_PRINCIPAL:"2"});
  let upstreamVersion:any={major:3,minor:3,patch:5,prerelease:null};
  const app=await Application.create(settings,{http:(async()=>Response.json(upstreamVersion)) as typeof fetch,versionIntervalMs:0,cleanupIntervalMs:0});
  try{
    assert.equal(app.executor.maxBytes,8192);assert.equal(app.executor.inlineBytes,256);assert.equal(app.executor.jsonValueBytes,2048);assert.equal(app.executor.resultTtlMs,10000);
    assert.equal(app.tools.views.maxBytes,256);assert.equal(app.tools.views.ttlMs,10000);assert.equal(app.staging.ttlMs,20000);assert.equal(app.jobs.maxPending,2);
    assert.equal((await stat(settings.databasePath!)).isFile(),true);
    const url=settings.publicOrigin+"/health/ready";assert.equal((await app.fetch(new Request(url))).status,200);
    const raw=await app.vault.capture("A",(async function*(){yield Buffer.from("raw");})(),100);
    const path=join(settings.directory,"objects",raw.raw_ref);await unlink(path);await mkdir(path);app.vault.db.prepare("UPDATE records SET expires=0 WHERE id=?").run(raw.raw_ref);
    await app.cleanStorage();assert.equal((await app.fetch(new Request(url))).status,503);
    await rmdir(path);await writeFile(path,"expired");await app.cleanStorage();
    assert.equal((await app.fetch(new Request(url))).status,200);
    upstreamVersion={major:3,minor:3,patch:5};await app.checkVersion();assert.equal(app.health.state,"unreachable");
    upstreamVersion={major:3,minor:3,patch:5,prerelease:1};await app.checkVersion();assert.equal(app.health.state,"version_mismatch");
    upstreamVersion={major:3,minor:3,patch:5,prerelease:null};await app.checkVersion();assert.equal(app.health.state,"ok");
    upstreamVersion={major:3,minor:3,patch:6,prerelease:null};await app.checkVersion();assert.equal(app.health.state,"ok");
    assert.equal((await app.fetch(new Request(url))).status,200);
    for(const value of [{major:3,minor:3,patch:7,prerelease:null},{major:3,minor:4,patch:0,prerelease:null},{major:3,minor:3,patch:6,prerelease:1}]){
      upstreamVersion=value;await app.checkVersion();assert.equal(app.health.state,"version_mismatch");
      assert.equal((await app.fetch(new Request(url))).status,503);
      assert.throws(()=>app.assertVersion("getMyUser"),{code:"version_mismatch"});
    }
    upstreamVersion={major:3,minor:3,patch:6,prerelease:null};await app.checkVersion();assert.equal(app.health.state,"ok");
  }finally{await app.close();}
}));

test("configuration permits the reviewed 3.3.6 patch without allowing future versions",()=>fixture(async(env)=>{
  for(const version of ["3.3.5","3.3.6"])await config({...env,IMMICH_EXPECTED_VERSION:version});
  for(const version of ["3.3.4","3.3.7","3.4.0","3.3.6-rc.1"])await assert.rejects(config({...env,IMMICH_EXPECTED_VERSION:version}),/reviewed Immich versions/);
}));
