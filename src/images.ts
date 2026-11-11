import { createHash,randomUUID } from "node:crypto";
import sharp from "sharp";
import { Vault } from "./vault.js";
import { Control } from "./control.js";
import { readDecoded } from "./content-encoding.js";
import { BridgeError } from "./types.js";

// Cache neither originals nor previews in libvips. All retained originals stay in the encrypted vault.
sharp.cache(false);
sharp.concurrency(1);
const MAX_INPUT_BYTES=32*1024*1024,MAX_INPUT_PIXELS=40_000_000,MAX_OUTPUT_BYTES=1024*1024;
const MAX_DIMENSION=2048,MAX_ACTIVE=2;
const resultPattern=/^result_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const supported=new Map([["image/jpeg","jpeg"],["image/png","png"],["image/webp","webp"]]);
export interface ImageInput {result_ref:string;max_width?:number;max_height?:number;format?:"jpeg"|"webp";}
export interface ImageTrace {
  event:"image_read";request_id:string;result_ref_hash?:string;stage:string;code:string;
  input_mime?:string;input_bytes?:number;output_mime?:string;output_bytes?:number;content_type?:"image";
}
export class ImageReadError extends BridgeError {
  constructor(code:string,message:string,readonly requestId:string){super(code,message);}
}
export const imageDescriptor={
  name:"immich_read_image",
  description:"Use this when ChatGPT needs to see or describe an image already fetched by viewAsset or another image operation. Wait for the API job to complete, then pass its result_ref. Returns a model-visible MCP image content part, resized and stripped of metadata. immich_read_result preview is JSON metadata only. Does not fetch URLs or repeat upstream requests. JPEG, PNG and single-frame WebP inputs; JPEG (default) or WebP output. Read one image at a time when summarizing several photos.",
  inputSchema:{type:"object",properties:{
    result_ref:{type:"string",pattern:resultPattern.source,description:"Image result_ref returned by a completed Immich API call or job."},
    max_width:{type:"integer",minimum:1,maximum:MAX_DIMENSION,default:1600,description:"Maximum output width; aspect ratio is preserved and small images are not enlarged."},
    max_height:{type:"integer",minimum:1,maximum:MAX_DIMENSION,default:1600,description:"Maximum output height."},
    format:{type:"string",enum:["jpeg","webp"],default:"jpeg",description:"Use jpeg for the default ChatGPT image path."}
  },required:["result_ref"],additionalProperties:false},
  outputSchema:{type:"object",properties:{
    request_id:{type:"string"},result_ref:{type:"string"},mime_type:{type:"string",enum:["image/jpeg","image/webp"]},
    width:{type:"integer",minimum:1},height:{type:"integer",minimum:1},size_bytes:{type:"integer",minimum:1,maximum:MAX_OUTPUT_BYTES},
    metadata_removed:{type:"boolean",const:true},content_type:{type:"string",const:"image"}
  },required:["request_id","result_ref","mime_type","width","height","size_bytes","metadata_removed","content_type"],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  _meta:{}
};
function signature(bytes:Buffer){
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return "jpeg";
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "png";
  if(bytes.length>=12&&bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP")return "webp";
  return undefined;
}
export class Images {
  private active=0;
  constructor(readonly vault:Vault,readonly control:Control,private trace:(event:ImageTrace)=>void=event=>console.info(JSON.stringify(event))) {}
  private emit(event:ImageTrace){try{this.trace(event);}catch{/* Diagnostics must never affect access control or tool results. */}}
  private authorized(principal:string,ref:string){
    // Only the owner's row is inspected. Missing and foreign references share one error.
    const row=this.vault.db.prepare("SELECT expires FROM records WHERE principal=? AND id=? AND kind='result'").get(principal,ref) as {expires:number}|undefined;
    if(!row)throw new BridgeError("invalid_reference","Image result is unavailable");
    if(row.expires<Date.now())throw new BridgeError("image_reference_expired","Image result has expired; request a new image");
    try{this.control.readResult(principal,ref);}
    catch(error){
      if(error instanceof BridgeError&&["invalid_reference","key_required","credential_conflict","context_expired","context_disabled","invalid_context","context_revalidation_required"].includes(error.code))
        throw new BridgeError("image_reference_forbidden","Image result authorization has changed");
      throw error;
    }
    return this.vault.get(principal,ref,"result");
  }
  async read(principal:string,input:ImageInput,signal?:AbortSignal){
    const requestId="img_"+randomUUID();
    const event:ImageTrace={event:"image_read",request_id:requestId,stage:"validate",code:"image_failed"};
    let release:(()=>void)|undefined,acquired=false;
    const fail=(code:string,message:string):never=>{throw new BridgeError(code,message);};
    const checkSignal=()=>{if(signal?.aborted)fail("image_cancelled","Image read was cancelled");};
    try{
      if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!["result_ref","max_width","max_height","format"].includes(k))||
        typeof input.result_ref!=="string"||!resultPattern.test(input.result_ref))fail("invalid_reference","Expected an image result_ref");
      event.result_ref_hash=createHash("sha256").update(input.result_ref).digest("hex").slice(0,24);
      const width=input.max_width ?? 1600,height=input.max_height ?? 1600,format=input.format ?? "jpeg";
      if(![width,height].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=MAX_DIMENSION)||!["jpeg","webp"].includes(format))
        fail("invalid_image_options","Image bounds must be 1 to 2048 and format must be jpeg or webp");
      checkSignal();event.stage="authorize";
      const result=this.authorized(principal,input.result_ref);
      if(result.display?.state!=="completed"||result.display?.upstream?.status!==200||result.raw?.interrupted)
        fail("image_result_incomplete","Only complete HTTP 200 image results can be read");
      const mime=result.display.upstream.content_type,expected=supported.get(mime);
      if(!expected)fail("image_unsupported_mime","Supported image inputs are JPEG, PNG and single-frame WebP");
      event.input_mime=mime;
      const raw=this.vault.get(principal,result.raw.raw_ref,"raw");
      if(raw.transfer_complete===false||raw.size!==result.raw.size||raw.sha256!==result.raw.sha256)
        fail("image_result_incomplete","Stored image transfer is incomplete");
      event.input_bytes=raw.size;
      if(!Number.isSafeInteger(raw.size)||raw.size<1||raw.size>MAX_INPUT_BYTES)
        fail("image_size_exceeded","Image source exceeds the 32 MiB input limit");
      if(this.active>=MAX_ACTIVE)fail("image_busy","Two image reads are already active; retry after they finish");
      this.active++;acquired=true;release=this.vault.pin(principal,input.result_ref);
      event.stage="read";
      let bytes:Buffer;
      try{bytes=await readDecoded(this.vault.rawStream(principal,result.raw.raw_ref),result.raw.content_encoding ?? "identity",MAX_INPUT_BYTES,signal);}
      catch(error){
        checkSignal();
        if(error instanceof BridgeError&&["result_limit","decoded_result_limit"].includes(error.code))fail("image_size_exceeded","Decoded image exceeds the 32 MiB input limit");
        fail("image_decode_failed","Stored image could not be read completely");
      }
      checkSignal();event.stage="decode";
      const actual=signature(bytes!);
      if(!actual)fail("image_decode_failed","Image data is not a supported raster image");
      if(actual!==expected)fail("image_mime_mismatch","Image bytes do not match the declared MIME type");
      const options={limitInputPixels:MAX_INPUT_PIXELS,limitInputChannels:4,failOn:"warning" as const};
      const metadata=await sharp(bytes!,options).metadata();
      if(!metadata.width||!metadata.height||metadata.width*metadata.height>MAX_INPUT_PIXELS)
        fail("image_size_exceeded","Image exceeds the 40 megapixel input limit");
      if(metadata.format!==expected)fail("image_mime_mismatch","Decoded format does not match the declared MIME type");
      if((metadata.pages ?? 1)!==1)fail("image_unsupported_mime","Animated or multi-page images are not supported");
      checkSignal();event.stage="encode";
      const encode=(w:number,h:number,quality:number)=>{
        const pipeline=sharp(bytes!,options).rotate().resize({width:w,height:h,fit:"inside",withoutEnlargement:true})
          .flatten({background:"#ffffff"}).toColourspace("srgb").timeout({seconds:5});
        // Do not call keepMetadata/withMetadata: EXIF, GPS, XMP, IPTC and ICC are removed.
        return (format==="webp"?pipeline.webp({quality}):pipeline.jpeg({quality})).toBuffer({resolveWithObject:true});
      };
      let output=await encode(width,height,80);checkSignal();
      if(output.data.length>MAX_OUTPUT_BYTES){output=await encode(Math.min(width,1024),Math.min(height,1024),60);checkSignal();}
      if(output.data.length<1||output.data.length>MAX_OUTPUT_BYTES)fail("image_size_exceeded","Converted image exceeds the 1 MiB output limit");
      event.stage="authorize_return";
      // Recheck TTL, credential revision and context generation after asynchronous decoding.
      this.authorized(principal,input.result_ref);
      this.vault.get(principal,result.raw.raw_ref,"raw");checkSignal();
      const mimeType=format==="webp"?"image/webp":"image/jpeg";
      const meta={request_id:requestId,result_ref:input.result_ref,mime_type:mimeType,width:output.info.width,height:output.info.height,
        size_bytes:output.data.length,metadata_removed:true,content_type:"image"};
      event.stage="return";event.code="ok";event.output_mime=mimeType;event.output_bytes=output.data.length;event.content_type="image";
      this.emit(event);
      return {content:[{type:"image" as const,data:output.data.toString("base64"),mimeType},
        {type:"text" as const,text:JSON.stringify(meta)}],structuredContent:meta};
    }catch(error){
      const native=error instanceof Error?error.message:"";
      const normalized=error instanceof BridgeError?error:
        /pixel limit/i.test(native)?new BridgeError("image_size_exceeded","Image exceeds the 40 megapixel input limit"):
        /timeout/i.test(native)?new BridgeError("image_conversion_timeout","Image conversion exceeded its time limit"):
        new BridgeError(event.stage==="decode"?"image_decode_failed":"image_conversion_failed","Image decoding or conversion failed");
      event.code=normalized.code;this.emit(event);
      throw new ImageReadError(normalized.code,normalized.message,requestId);
    }finally{release?.();if(acquired)this.active--;}
  }
}
