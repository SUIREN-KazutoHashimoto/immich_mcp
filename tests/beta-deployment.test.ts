import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("beta image, package and OCI release identities agree without changing the target Immich API",async()=>{
  const pkg=JSON.parse(await readFile("package.json","utf8")),dockerfile=await readFile("Dockerfile","utf8");
  assert.match(pkg.version,/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/);
  assert.equal(/org\.opencontainers\.image\.version="([^"]+)"/.exec(dockerfile)?.[1],pkg.version);
  for(const file of ["compose.yaml","compose.beta.yaml"]){
    const compose=JSON.parse(await readFile(file,"utf8"));
    assert.equal(compose.services.mcp.image,"$"+"{MCP_IMAGE:-immich-mcp:"+pkg.version+"}");
  }
  assert.ok((await readFile("deploy/beta.env.example","utf8")).includes("MCP_IMAGE=immich-mcp:"+pkg.version));
  const registry=JSON.parse(await readFile("src/generated/registry.json","utf8"));
  assert.equal(registry.version,"3.3.5");assert.equal(registry.operations.length,279);
});

test("the independent beta stack exposes only loopback health access and retains runtime isolation without a tunnel token",async()=>{
  const stack=JSON.parse(await readFile("compose.beta.yaml","utf8")),mcp=stack.services.mcp;
  assert.deepEqual(Object.keys(stack.services),["mcp"]);assert.deepEqual(Object.keys(stack.secrets),["vault_master_key"]);
  assert.deepEqual(mcp.ports,[{target:3000,published:"$"+"{MCP_TEST_PORT:-3000}",host_ip:"127.0.0.1",protocol:"tcp"}]);
  assert.equal(mcp.user,"1000:1000");assert.equal(mcp.read_only,true);assert.deepEqual(mcp.cap_drop,["ALL"]);
  assert.ok(mcp.security_opt.includes("no-new-privileges:true"));assert.equal(mcp.network_mode,undefined);assert.equal(mcp.privileged,undefined);
  assert.equal(mcp.environment.VAULT_MASTER_KEY_FILE,"/run/secrets/vault_master_key");
  assert.equal(mcp.environment.DATABASE_PATH,"/data/vault.sqlite");
  assert.deepEqual(mcp.volumes.map((x:any)=>[x.target,x.type,x.bind.create_host_path]),[["/data","bind",false]]);
  assert.deepEqual(Object.keys(mcp.networks).sort(),["immich","mcp_egress"]);
  assert.deepEqual(mcp.networks.immich.aliases,["immich-mcp-beta1"]);assert.equal(stack.networks.immich.external,true);
  assert.equal(mcp.pull_policy,"never");assert.equal(mcp.restart,"no");
  assert.ok(!JSON.stringify(stack).includes("tunnel_token"));assert.ok(!JSON.stringify(stack).includes("docker.sock"));
});
