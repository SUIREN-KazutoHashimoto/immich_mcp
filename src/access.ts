import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { BridgeError } from "./types.js";
export interface AccessConfig { issuer:string; audience:string; jwksUrl:string; publicOrigin:string; }
export class AccessAuth {
  private keys: JWTVerifyGetKey;
  constructor(readonly config:AccessConfig, keys?:JWTVerifyGetKey) {
    const issuer=new URL(config.issuer), jwks=new URL(config.jwksUrl);
    if(issuer.protocol!=="https:" || jwks.protocol!=="https:" || jwks.origin!==issuer.origin ||
      jwks.pathname!=="/cdn-cgi/access/certs" || jwks.search || jwks.hash || !config.audience)
      throw Error("Access issuer, audience and trusted JWKS endpoint are required");
    if(new URL(config.publicOrigin).protocol!=="https:") throw Error("Public origin must use HTTPS");
    this.keys=keys ?? createRemoteJWKSet(jwks,{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:600000});
  }
  async authenticate(assertion:string|undefined) {
    if(!assertion) throw new BridgeError("unauthenticated","Access authentication required");
    try {
      const {payload}=await jwtVerify(assertion,this.keys,{
        issuer:this.config.issuer,audience:this.config.audience,algorithms:["RS256"],
        requiredClaims:["iss","sub","aud","exp"],clockTolerance:5});
      if(typeof payload.sub!=="string" || !payload.sub.trim()) throw Error();
      return createHash("sha256").update(JSON.stringify([payload.iss,payload.sub])).digest("hex");
    } catch { throw new BridgeError("unauthenticated","Invalid Access assertion"); }
  }
  validateOrigin(origin:string|undefined,required=false) {
    if((required && !origin) || (origin && origin!==new URL(this.config.publicOrigin).origin))
      throw new BridgeError("invalid_origin","Origin is not allowed");
  }
}
export class Csrf {
  constructor(private key:Buffer) {if(key.length<32)throw Error("CSRF signing key too short");}
  issue(principal:string) {
    const token=Date.now()+"."+randomBytes(24).toString("base64url");
    return token+"."+this.sign(principal,token);
  }
  private sign(principal:string,value:string) {return createHmac("sha256",this.key).update(JSON.stringify([principal,value])).digest("base64url");}
  verify(principal:string,token:string,cookie:string) {
    const parts=token.split(".");
    const time=Number(parts[0]);
    if(parts.length!==3 || !Number.isFinite(time) || time>Date.now()+5000 || Date.now()-time>1800000 ||
       cookie!==token) throw new BridgeError("csrf","Invalid or expired form token");
    const expected=Buffer.from(this.sign(principal,parts[0]+"."+parts[1]));
    const actual=Buffer.from(parts[2]!);
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new BridgeError("csrf","Invalid form token");
  }
}
