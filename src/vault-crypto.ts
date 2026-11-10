import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
export type CryptoFormat=1|2;
export const validVersion=(version:unknown):version is string=>typeof version==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version);
export function vaultAad(format:CryptoFormat,keyVersion:string,serverId:string,principal:string,id:string,kind:string){
  return Buffer.from(JSON.stringify(format===1?[1,serverId,principal,id,kind]:[2,serverId,principal,id,kind,keyVersion]));
}
export function encryptRecord(key:Buffer,format:CryptoFormat,keyVersion:string,serverId:string,principal:string,id:string,kind:string,data:any){
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(vaultAad(format,keyVersion,serverId,principal,id,kind));
  const body=Buffer.concat([cipher.update(JSON.stringify(data),"utf8"),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),body]);
}
export function decryptRecord(key:Buffer,format:CryptoFormat,keyVersion:string,serverId:string,principal:string,id:string,kind:string,payload:Uint8Array){
  if(payload.length<28)throw Error("Invalid encrypted record");
  const decipher=createDecipheriv("aes-256-gcm",key,payload.subarray(0,12));
  decipher.setAuthTag(payload.subarray(12,28));decipher.setAAD(vaultAad(format,keyVersion,serverId,principal,id,kind));
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()])));
}
