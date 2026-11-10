import { readFile,realpath,lstat } from "node:fs/promises";
import { resolve,join,dirname,basename,relative,isAbsolute,sep } from "node:path";
import { supportedImmichVersions } from "./immich-version.js";
export interface Config {
  upstream:string;publicOrigin:string;issuer:string;audience:string;jwksUrl:string;
  directory:string;masterKey:Buffer;masterKeyFile?:string;host:string;port:number;fileSourceHosts?:string[];maxUploadBytes?:number;storageQuotaBytes?:number;
  globalStorageQuotaBytes?:number;databasePath?:string;maxResultBytes?:number;inlineResultMaxBytes?:number;jsonValueMaxBytes?:number;
  resultTtlMs?:number;stagingTtlMs?:number;cleanupIntervalMs?:number;maxJobsPerPrincipal?:number;
  maxUpstreamConcurrency?:number;upstreamConnectTimeoutMs?:number;upstreamIdleTimeoutMs?:number;maxDecodedResultBytes?:number;
}
export async function config(env:NodeJS.ProcessEnv=process.env):Promise<Config>{
  const required=(name:string)=>{const value=env[name];if(!value)throw Error(name+" is required");return value;};
  const integer=(name:string,fallback:number,max=Number.MAX_SAFE_INTEGER)=>{
    const text=env[name] ?? String(fallback),value=Number(text);
    if(!/^[0-9]+$/.test(text)||!Number.isSafeInteger(value)||value<1||value>max)throw Error("Invalid "+name);
    return value;
  };
  if(env.IMMICH_EXPECTED_VERSION&&!supportedImmichVersions.includes(env.IMMICH_EXPECTED_VERSION))throw Error("Only reviewed Immich versions "+supportedImmichVersions.join(", ")+" are supported");
  const upstream=new URL(required("IMMICH_BASE_URL"));
  if(!["http:","https:"].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash||upstream.pathname.replace(/\/$/,"")!=="/api")
    throw Error("IMMICH_BASE_URL must be the fixed origin plus /api");
  const publicUrl=new URL(required("MCP_PUBLIC_BASE_URL"));
  if(publicUrl.protocol!=="https:"||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||publicUrl.pathname!=="/")
    throw Error("MCP_PUBLIC_BASE_URL must be an HTTPS origin");
  const prospective=async(path:string):Promise<string>=>{
    try{return await realpath(path);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT"||dirname(path)===path)throw error;
      return join(await prospective(dirname(path)),basename(path));
    }
  };
  const directory=await prospective(resolve(env.STORAGE_PATH ?? "./data"));
  if(env.DATABASE_PATH===":memory:")throw Error("DATABASE_PATH must persist to a file");
  const maxResultBytes=integer("MAX_RESULT_BYTES",1073741824),inlineResultMaxBytes=integer("INLINE_RESULT_MAX_BYTES",131072);
  if(inlineResultMaxBytes>maxResultBytes)throw Error("INLINE_RESULT_MAX_BYTES exceeds MAX_RESULT_BYTES");
  const settings={upstream:upstream.toString().replace(/\/$/,""),publicOrigin:publicUrl.origin,
    issuer:required("ACCESS_ISSUER"),audience:required("ACCESS_AUDIENCE"),jwksUrl:required("ACCESS_JWKS_URL"),
    directory,databasePath:await prospective(resolve(env.DATABASE_PATH ?? join(directory,"vault.sqlite"))),
    fileSourceHosts:(env.FILE_SOURCE_ALLOWED_HOSTS ?? "").split(",").map(s=>s.trim()).filter(Boolean),
    maxUploadBytes:integer("MAX_UPLOAD_BYTES",1073741824),storageQuotaBytes:integer("STORAGE_QUOTA_BYTES",3221225472),globalStorageQuotaBytes:integer("GLOBAL_STORAGE_QUOTA_BYTES",12884901888),
    maxResultBytes,inlineResultMaxBytes,jsonValueMaxBytes:integer("JSON_VALUE_MAX_BYTES",1048576),
    maxDecodedResultBytes:integer("MAX_DECODED_RESULT_BYTES",maxResultBytes),
    maxUpstreamConcurrency:integer("MAX_UPSTREAM_CONCURRENCY",8,2147483647),
    upstreamConnectTimeoutMs:integer("UPSTREAM_CONNECT_TIMEOUT_MS",10000,2147483647),
    upstreamIdleTimeoutMs:integer("UPSTREAM_IDLE_TIMEOUT_MS",30000,2147483647),
    resultTtlMs:integer("RESULT_TTL_SECONDS",3600,Math.floor(Number.MAX_SAFE_INTEGER/1000))*1000,
    stagingTtlMs:integer("STAGING_TTL_SECONDS",3600,Math.floor(Number.MAX_SAFE_INTEGER/1000))*1000,
    cleanupIntervalMs:integer("CLEANUP_INTERVAL_SECONDS",60,Math.floor(Number.MAX_SAFE_INTEGER/1000))*1000,
    maxJobsPerPrincipal:integer("MAX_JOBS_PER_PRINCIPAL",50),
    host:env.MCP_LISTEN_HOST ?? "127.0.0.1",port:integer("MCP_LISTEN_PORT",3000,65535)};
  const masterKeyFile=await realpath(required("VAULT_MASTER_KEY_FILE")),rel=relative(directory,masterKeyFile);
  if(rel===""||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel))throw Error("Master key must be separate from the storage directory");
  const info=await lstat(masterKeyFile);if(!info.isFile()||info.size!==32)throw Error("Master key file must contain exactly 32 raw bytes");
  const masterKey=await readFile(masterKeyFile);if(masterKey.length!==32){masterKey.fill(0);throw Error("Master key file must contain exactly 32 raw bytes");}
  return {...settings,masterKeyFile,masterKey};
}
