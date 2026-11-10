import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { AccessAuth,Csrf } from "../src/access.js";
test("Access JWT signature, issuer, audience, expiry, not-before and nonempty subject",async()=>{
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);jwk.kid="test-key";
  const config={issuer:"https://team.cloudflareaccess.com",audience:"app-a",jwksUrl:"https://team.cloudflareaccess.com/cdn-cgi/access/certs",publicOrigin:"https://mcp.example.com"};
  const access=new AccessAuth(config,createLocalJWKSet({keys:[jwk]}));
  const sign=async(extra:Record<string,any>={})=>new SignJWT({iss:config.issuer,aud:config.audience,sub:"A",exp:Math.floor(Date.now()/1000)+300,...extra}).setProtectedHeader({alg:"RS256",kid:"test-key"}).sign(privateKey);
  const principal=await access.authenticate(await sign());
  assert.equal(principal,await access.authenticate(await sign({email:"different@example.com"})));
  assert.notEqual(principal,await access.authenticate(await sign({sub:"B"})));
  for(const extra of [{iss:"https://evil.example"},{aud:"other"},{sub:""},{exp:1},{nbf:Math.floor(Date.now()/1000)+600}])
    await assert.rejects(access.authenticate(await sign(extra)),{code:"unauthenticated"});
  await assert.rejects(access.authenticate(undefined));
  const good=await sign();await assert.rejects(access.authenticate(good.slice(0,-8)+"AAAAAAAA"));
  assert.throws(()=>new AccessAuth({...config,jwksUrl:"https://evil.example/certs"}));
  assert.throws(()=>access.validateOrigin("https://evil.example"));
  access.validateOrigin(undefined);
  assert.throws(()=>access.validateOrigin(undefined,true));
});
test("CSRF tokens are principal-bound, cookie-bound, authenticated and origin-independent",()=>{
  const csrf=new Csrf(randomBytes(32));const a=csrf.issue("A");
  csrf.verify("A",a,a);
  assert.throws(()=>csrf.verify("B",a,a));
  assert.throws(()=>csrf.verify("A",a,""));
  assert.throws(()=>csrf.verify("A",a.replace(/.$/,"!"),a.replace(/.$/,"!")));
});
