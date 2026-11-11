import { createHash } from "node:crypto";
import { readFile,stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export async function inspectImageResult(value:any){
  const result=value?.jsonrpc==="2.0"?value.result:value;
  const parts=Array.isArray(result?.content)?result.content.filter((p:any)=>p?.type==="image"):[];
  const report={ok:false,image_parts:parts.length,structured_metadata_present:!!result?.structuredContent,
    viewer_image_present:result?._meta?.image_content?.type==="image",images:[] as Array<{mime_type:string;bytes:number;width:number;height:number;sha256:string}>};
  if(result?.isError)throw new Error("mcp_tool_error");
  for(const p of parts){
    if(!["image/jpeg","image/webp"].includes(p.mimeType)||typeof p.data!=="string"||!p.data.length||p.data.length>1398104||p.data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(p.data))throw new Error("invalid_image_content");
    const bytes=Buffer.from(p.data,"base64");if(!bytes.length||bytes.length>1048576)throw new Error("image_size_exceeded");
    const meta=await sharp(bytes,{limitInputPixels:4_194_304,limitInputChannels:4}).metadata();
    if(!meta.width||!meta.height||meta.width>2048||meta.height>2048||"image/"+meta.format!==p.mimeType)throw new Error("invalid_image_content");
    await sharp(bytes,{limitInputPixels:4_194_304,limitInputChannels:4}).stats();
    report.images.push({mime_type:p.mimeType,bytes:bytes.length,width:meta.width,height:meta.height,sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  report.ok=parts.length>0;return report;
}
async function main(){
  try{
    const file=process.argv[2];if(!file)throw new Error("capture_required");
    if((await stat(file)).size>6*1024*1024)throw new Error("capture_too_large");
    const report=await inspectImageResult(JSON.parse(await readFile(file,"utf8")));
    console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;
  }catch{console.error(JSON.stringify({ok:false,code:"image_response_invalid"}));process.exitCode=1;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
