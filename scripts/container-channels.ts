import { readFileSync,appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type Channel="stable"|"beta";
export interface Version {version:string;channel:Channel;numbers:bigint[];}
export function version(value:string):Version|null {
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(value);
  if(!match||match[0]!==value||value.length>128)return null;
  return {version:value,channel:match[4]?"beta":"stable",numbers:match.slice(1,4).map(x=>BigInt(x!)).concat(match[4]?[BigInt(match[4])]:[])};
}
export function compare(a:Version,b:Version){
  for(let i=0;i<3;i++){if(a.numbers[i]!==b.numbers[i])return a.numbers[i]!>b.numbers[i]!?1:-1;}
  if(a.channel!==b.channel)return a.channel==="stable"?1:-1;
  const x=a.numbers[3]??0n,y=b.numbers[3]??0n;return x===y?0:x>y?1:-1;
}
export interface Release {tag_name:string;draft:boolean;prerelease:boolean;}
export function channelCandidates(tags:string[],releases:Release[]){
  const stable=new Set(releases.filter(r=>!r.draft&&!r.prerelease).map(r=>r.tag_name));
  const result:Partial<Record<Channel,Version>>={};
  for(const tag of tags){
    const parsed=version(tag);if(!parsed||parsed.channel==="stable"&&!stable.has("v"+tag))continue;
    if(!result[parsed.channel]||compare(parsed,result[parsed.channel]!)>0)result[parsed.channel]=parsed;
  }
  return result;
}
export function publicationVersion(value:string,event:any,sha:string){
  const parsed=version(value);if(!parsed||!/^[0-9a-f]{40}$/.test(sha))throw Error("Invalid container release version or source commit");
  if(event?.release && (event.action!=="published"||event.release.draft||event.release.tag_name!=="v"+value||
    event.release.prerelease!==(parsed.channel==="beta")))throw Error("Release tag/type does not match package version");
  return parsed;
}
const digestPattern=/^sha256:[0-9a-f]{64}$/;
const accept="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
export class Registry {
  image:string;repository:string;request:typeof fetch;bearer:string;origin:string;
  constructor(image:string,bearer:string,request:typeof fetch=fetch,origin="https://ghcr.io"){
    if(!/^ghcr\.io\/[a-z0-9][a-z0-9-]*\/immich-mcp$/.test(image))throw Error("Unexpected container repository");
    this.image=image;this.repository=image.slice(8);this.bearer=bearer;this.request=request;this.origin=origin;
  }
  static async connect(image:string,githubToken?:string,actor?:string,request:typeof fetch=fetch){
    const registry=new Registry(image,"",request);
    const url=new URL("https://ghcr.io/token");url.searchParams.set("service","ghcr.io");url.searchParams.set("scope","repository:"+registry.repository+":pull");
    const response=await request(url,{redirect:"error",signal:AbortSignal.timeout(30000),headers:githubToken&&actor?{authorization:"Basic "+Buffer.from(actor+":"+githubToken).toString("base64")}:{}});
    if(!response.ok)throw Error("Registry authorization failed (HTTP "+response.status+")");
    const data=await response.json() as any;if(typeof data.token!=="string"||!data.token)throw Error("Registry token missing");
    registry.bearer=data.token;return registry;
  }
  private async get(path:string,method="GET"){
    const response=await this.request(this.origin+path,{method,redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{authorization:"Bearer "+this.bearer,accept}});
    if(response.status!==404&&!response.ok)throw Error("Registry read failed (HTTP "+response.status+")");
    return response;
  }
  async digest(ref:string){
    if(!/^[A-Za-z0-9_.-]{1,128}$/.test(ref))throw Error("Invalid image tag");
    const response=await this.get("/v2/"+this.repository+"/manifests/"+encodeURIComponent(ref),"HEAD");
    if(response.status===404)return null;
    const value=response.headers.get("docker-content-digest");if(!value||!digestPattern.test(value))throw Error("Registry manifest digest missing");
    return value;
  }
  async tags(){
    const path="/v2/"+this.repository+"/tags/list",tags:string[]=[];let next=path+"?n=100";const seen=new Set<string>();
    for(let page=0;page<100;page++){
      if(seen.has(next))throw Error("Registry pagination loop");seen.add(next);
      const response=await this.get(next);if(response.status===404)throw Error("Container repository missing");
      const data=await response.json() as any;
      if(data.name!==this.repository||!Array.isArray(data.tags)||data.tags.some((x:any)=>typeof x!=="string"||x.length>128))throw Error("Invalid registry tag response");
      tags.push(...data.tags);
      const link=response.headers.get("link"),match=link&&/<([^>]+)>;\s*rel="?next"?/.exec(link);
      if(!match)return [...new Set(tags)];
      const url=new URL(match[1]!,this.origin);
      if(url.origin!==this.origin||url.pathname!==path||url.username||url.password)throw Error("Unexpected registry pagination target");
      next=url.pathname+url.search;
    }
    throw Error("Registry tag pagination exceeds limit");
  }
}
export type Docker=(args:string[])=>string;
export const docker:Docker=args=>{
  try{return execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:4*1024*1024});}
  catch{throw Error("Docker command failed: "+args.slice(0,2).join(" "));}
};
export function inspectImage(run:Docker,image:string,expectedVersion:string,repository:string,revision?:string){
  const records=JSON.parse(run(["image","inspect",image])),record=records?.[0],labels=record?.Config?.Labels;
  if(records.length!==1||record.Os!=="linux"||record.Architecture!=="amd64"||record.Config.User!=="1000:1000"||
    labels?.["org.opencontainers.image.version"]!==expectedVersion||labels?.["org.opencontainers.image.source"]!=="https://github.com/"+repository||
    !/^[0-9a-f]{40}$/.test(labels?.["org.opencontainers.image.revision"]??"")||
    revision&&labels["org.opencontainers.image.revision"]!==revision)throw Error("Container metadata does not match the verified version/source");
  return labels["org.opencontainers.image.revision"] as string;
}
export async function prepareVersion(registry:Registry,run:Docker,value:string,repository:string,revision:string){
  if(!version(value))throw Error("Invalid fixed version");
  const existing=await registry.digest(value);if(!existing)return {reuse:false,digest:null};
  run(["pull",registry.image+"@"+existing]);
  inspectImage(run,registry.image+"@"+existing,value,repository,revision);
  run(["tag",registry.image+"@"+existing,registry.image+":"+value]);
  return {reuse:true,digest:existing};
}
export async function githubPages(repository:string,token:string,path:string,key?:string,request:typeof fetch=fetch){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!path.startsWith("/"))throw Error("Invalid GitHub repository");
  const all:any[]=[];
  for(let page=1;page<=100;page++){
    const response=await request("https://api.github.com/repos/"+repository+path+(path.includes("?")?"&":"?")+"per_page=100&page="+page,
      {redirect:"error",signal:AbortSignal.timeout(30000),headers:{authorization:"Bearer "+token,accept:"application/vnd.github+json","user-agent":"immich-mcp-channels"}});
    if(!response.ok)throw Error("GitHub validation failed (HTTP "+response.status+")");
    const data=await response.json() as any,items=key?data[key]:data;if(!Array.isArray(items))throw Error("Invalid GitHub validation response");
    all.push(...items);if(items.length<100)return all;
  }
  throw Error("GitHub validation pagination exceeds limit");
}
export async function verifyStableTag(repository:string,token:string,tag:string,revision:string,request:typeof fetch=fetch){
  let path="/git/ref/tags/"+encodeURIComponent(tag);
  for(let depth=0;depth<6;depth++){
    const response=await request("https://api.github.com/repos/"+repository+path,{redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{authorization:"Bearer "+token,accept:"application/vnd.github+json","user-agent":"immich-mcp-channels"}});
    if(!response.ok)throw Error("Stable release tag validation failed");
    const value=await response.json() as any,obj=value.object;
    if(obj?.type==="commit"){if(obj.sha!==revision)throw Error("Stable release tag differs from the image source");return;}
    if(obj?.type!=="tag"||!/^[0-9a-f]{40}$/.test(obj.sha))throw Error("Invalid stable release tag");
    path="/git/tags/"+obj.sha;
  }
  throw Error("Stable release tag chain exceeds limit");
}
export interface Run {head_sha:string;conclusion:string;event:string;}
export async function refreshChannels(options:{registry:Registry;run:Docker;repository:string;token:string;releases:Release[];runs:Run[];dryRun:boolean;request?:typeof fetch}){
  const {registry,run,repository}=options,candidates=channelCandidates(await registry.tags(),options.releases),results:any[]=[];
  for(const channel of ["stable","beta"] as const){
    const candidate=candidates[channel];if(!candidate){results.push({channel,status:"no_eligible_version"});continue;}
    const targetDigest=await registry.digest(candidate.version);if(!targetDigest)throw Error("Selected version disappeared");
    const current=await registry.digest(channel);
    if(current===targetDigest){results.push({channel,version:candidate.version,digest:targetDigest,status:"unchanged"});continue;}
    if(current){
      run(["pull",registry.image+"@"+current]);
      const record=JSON.parse(run(["image","inspect",registry.image+"@"+current]))[0],currentVersion=version(record?.Config?.Labels?.["org.opencontainers.image.version"]??"");
      if(!currentVersion||currentVersion.channel!==channel)throw Error("Current channel has invalid version metadata");
      if(compare(currentVersion,candidate)>0){results.push({channel,version:currentVersion.version,status:"newer_channel_preserved"});continue;}
    }
    run(["pull",registry.image+"@"+targetDigest]);
    const revision=inspectImage(run,registry.image+"@"+targetDigest,candidate.version,repository);
    if(!options.runs.some(r=>r.head_sha===revision&&r.conclusion==="success"&&["workflow_dispatch","release"].includes(r.event)))
      throw Error("Selected image has no successful container publication run");
    if(channel==="stable")await verifyStableTag(repository,options.token,"v"+candidate.version,revision,options.request);
    if(options.dryRun){results.push({channel,version:candidate.version,digest:targetDigest,status:"dry_run"});continue;}
    run(["tag",registry.image+"@"+targetDigest,registry.image+":"+channel]);
    run(["push",registry.image+":"+channel]);
    if(await registry.digest(channel)!==targetDigest)throw Error("Published channel digest differs from the verified fixed image");
    results.push({channel,version:candidate.version,digest:targetDigest,status:"published"});
  }
  return results;
}
function output(values:Record<string,string>){
  if(!process.env.GITHUB_OUTPUT)throw Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>k+"="+v+"\n").join(""));
}
async function main(){
  const mode=process.argv[2],repository=process.env.GH_REPO??"",image=process.env.IMAGE??"",sha=process.env.GITHUB_SHA??"";
  if(image!=="ghcr.io/"+repository.split("/")[0]?.toLowerCase()+"/immich-mcp")throw Error("Image does not belong to this repository");
  const value=JSON.parse(readFileSync("package.json","utf8")).version as string;
  if(mode==="metadata"){
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!,"utf8")),parsed=publicationVersion(value,event,sha);
    output({version:value,channel:parsed.channel,image:image+":"+value});return;
  }
  const token=process.env.GH_TOKEN;if(!token)throw Error("GitHub token required");
  const registry=await Registry.connect(image,token,process.env.GITHUB_ACTOR);
  if(mode==="prepare"){
    const result=await prepareVersion(registry,docker,value,repository,sha);output({reuse:String(result.reuse)});return;
  }
  if(mode!=="refresh")throw Error("Unknown container publication command");
  const [releases,runs]=await Promise.all([
    githubPages(repository,token,"/releases"),
    githubPages(repository,token,"/actions/workflows/publish-ghcr.yml/runs?status=success","workflow_runs")
  ]);
  const results=await refreshChannels({registry,run:docker,repository,token,releases,runs,dryRun:process.env.DRY_RUN==="true"});
  const text=JSON.stringify({image,channels:results});console.log(text);
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,"## Container channels\n\n~~~json\n"+JSON.stringify(results,null,2)+"\n~~~\n");
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main().catch(error=>{console.error(error instanceof Error?error.message:"Container publication failed");process.exitCode=1;});
