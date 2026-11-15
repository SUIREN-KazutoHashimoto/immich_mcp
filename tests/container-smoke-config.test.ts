import test from "node:test";
import assert from "node:assert/strict";
import {AccessAuth} from "../src/access.js";
import {containerSmokeEnvironment as env} from "../scripts/container-smoke-config.js";
const access=(jwksUrl:string=new URL("/cdn-cgi/access/certs",env.ACCESS_ISSUER).href)=>({issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUDIENCE,jwksUrl,publicOrigin:env.MCP_PUBLIC_BASE_URL});
test("the real-container smoke environment satisfies the unchanged production Access configuration",()=>{
  assert.doesNotThrow(()=>new AccessAuth(access()));
  assert.deepEqual(Object.keys(env).sort(),["ACCESS_AUDIENCE","ACCESS_ISSUER","IMMICH_BASE_URL","MCP_PUBLIC_BASE_URL"]);
  assert.ok(Object.isFrozen(env));
});
test("the previous generic JWKS path remains invalid instead of weakening application authentication",()=>{
  assert.throws(()=>new AccessAuth(access(env.ACCESS_ISSUER+"/jwks")),/trusted JWKS endpoint/);
  assert.throws(()=>new AccessAuth(access("https://other.example.test/cdn-cgi/access/certs")),/trusted JWKS endpoint/);
});
