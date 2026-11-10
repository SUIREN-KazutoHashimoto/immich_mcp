import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import { BridgeError } from "./types.js";

const blocked4=new BlockList();
for(const [network,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)
  blocked4.addSubnet(network,prefix,"ipv4");
const global6=new BlockList();global6.addSubnet("2000::",3,"ipv6");
const blocked6=new BlockList();
for(const [network,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const)
  blocked6.addSubnet(network,prefix,"ipv6");
export function publicAddress(address:string) {
  const family=isIP(address);
  return family===4 ? !blocked4.check(address,"ipv4") :
    family===6 ? global6.check(address,"ipv6") && !blocked6.check(address,"ipv6") : false;
}
export interface SourceResponse {
  status:number; body:AsyncIterable<Uint8Array>; location?:string; mime?:string; length?:number; encoding?:string; close():void;
}
export type SourceConnector=(url:URL,address:LookupAddress,signal:AbortSignal)=>Promise<SourceResponse>;
export type SourceLookup=(hostname:string)=>Promise<LookupAddress[]>;
export const pinnedHttps:SourceConnector=(url,address,signal)=>new Promise((resolve,reject)=>{
  const req=request(url,{method:"GET",agent:false,signal,family:address.family,
    headers:{"accept-encoding":"identity"},servername:url.hostname,
    lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)},res=>{
    resolve({status:res.statusCode ?? 0,body:res,location:res.headers.location,mime:res.headers["content-type"],
      length:res.headers["content-length"]===undefined?undefined:Number(res.headers["content-length"]),
      encoding:res.headers["content-encoding"],close:()=>res.destroy()});
  });
  req.on("error",()=>reject(new BridgeError("source_unavailable","Attachment source connection failed")));
  req.setTimeout(15000,()=>req.destroy(new Error("Attachment source idle timeout")));
  req.end();
});
export class DownloadPolicy {
  private hosts:Set<string>;
  constructor(hosts:string[],readonly resolve:SourceLookup=(host)=>lookup(host,{all:true,verbatim:true}),readonly connect:SourceConnector=pinnedHttps) {
    this.hosts=new Set(hosts.map(host=>{
      if(!host || host.includes("*") || /[\s/:?#@]/.test(host) || isIP(host))throw Error("File source hosts must be exact DNS hostnames");
      const parsed=new URL("https://"+host);
      if(parsed.hostname!==host.toLowerCase() || host.endsWith("."))throw Error("Invalid file source hostname");
      return parsed.hostname;
    }));
  }
  validate(input:string|URL) {
    let url:URL;try{url=new URL(input);}catch{throw new BridgeError("source_denied","Invalid attachment source");}
    if(url.protocol!=="https:" || url.username || url.password || url.hash || url.port && url.port!=="443" ||
      !this.hosts.has(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g,"")))
      throw new BridgeError("source_denied","Attachment source is not allowed");
    return url;
  }
  async open(input:string,signal=AbortSignal.timeout(60000)):Promise<SourceResponse> {
    let url=this.validate(input);
    for(let redirects=0;redirects<=3;redirects++){
      signal.throwIfAborted();
      let addresses:LookupAddress[];
      try{addresses=await this.resolve(url.hostname);}catch{throw new BridgeError("source_unavailable","Attachment DNS resolution failed");}
      if(!addresses.length || addresses.some(a=>!publicAddress(a.address) || isIP(a.address)!==a.family))
        throw new BridgeError("source_denied","Attachment DNS resolved to an unsafe address");
      const response=await this.connect(url,addresses[0]!,signal);
      if([301,302,303,307,308].includes(response.status)){
        response.close();
        if(!response.location || redirects===3)throw new BridgeError("source_redirect","Attachment redirect limit or missing location");
        let next:URL;try{next=new URL(response.location,url);}catch{throw new BridgeError("source_redirect","Invalid attachment redirect");}
        url=this.validate(next);continue;
      }
      if(response.status!==200 || response.encoding && response.encoding!=="identity" ||
        response.length!==undefined && (!Number.isSafeInteger(response.length)||response.length<0)){
        response.close();throw new BridgeError("source_response","Attachment source did not return an unmodified file");
      }
      return response;
    }
    throw new BridgeError("source_redirect","Attachment redirect limit");
  }
}
