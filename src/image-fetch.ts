import { randomUUID } from "node:crypto";
import { Executor } from "./executor.js";
import { Control } from "./control.js";
import { Images,imageDescriptor,type ImageInput } from "./images.js";
import { BridgeError,type ApiCall } from "./types.js";
import { imageMetadata,imageSummary } from "./image-response.js";

export interface ImageFetchInput {source:"random"|"asset";asset_id?:string;max_width?:number;max_height?:number;format?:"jpeg"|"webp";}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const imageFetchDescriptor={
  name:"immich_get_image",
  description:"Use this first to display or describe one Immich photo: choose source random, or source asset with an asset_id. Fetches and returns the actual model-visible image in one call without catalog, schema lookup or job polling. For an existing completed result_ref use immich_read_image instead. Do not fetch the photo again to explain it: use the returned ImageContent. Returns native image content rather than JSON structuredContent; diagnostics are private image_info. In Code Mode forward image content blocks with image(block); a metadata-only wrapper is not image input: stop and report image_content_missing instead of repeating requests or guessing. Server display_status is unconfirmed; UI display and visual recognition are separate checks.",
  inputSchema:{type:"object",properties:{source:{type:"string",enum:["random","asset"]},asset_id:{type:"string",pattern:uuid.source},
    max_width:imageDescriptor.inputSchema.properties.max_width,max_height:imageDescriptor.inputSchema.properties.max_height,format:imageDescriptor.inputSchema.properties.format},
    required:["source"],additionalProperties:false,oneOf:[{properties:{source:{const:"asset"}},required:["asset_id"]},{properties:{source:{const:"random"}},not:{required:["asset_id"]}}]},
  outputSchema:{...imageDescriptor.outputSchema,properties:{...imageDescriptor.outputSchema.properties,asset_id:{type:"string",pattern:uuid.source}},required:[...imageDescriptor.outputSchema.required,"asset_id"]},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:imageDescriptor._meta
};
export class ImageFetch {
  constructor(readonly executor:Executor,readonly control:Control,readonly images:Images,readonly permit:(id:string)=>void,
    private trace:(value:unknown)=>void=value=>console.info(JSON.stringify(value))){}
  async get(principal:string,input:ImageFetchInput,outerSignal?:AbortSignal){
    const started=performance.now(),traceId="fetch_"+randomUUID(),timings:Record<string,number>={};
    let code="image_failed",imageRequestId:string|undefined;
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!["source","asset_id","max_width","max_height","format"].includes(k))||
      !["random","asset"].includes(input.source)||input.source==="asset"&&(typeof input.asset_id!=="string"||!uuid.test(input.asset_id))||input.source==="random"&&input.asset_id!==undefined||
      [input.max_width,input.max_height].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>2048))||input.format!==undefined&&!["jpeg","webp"].includes(input.format))
      throw new BridgeError("invalid_image_options","Choose random or one asset UUID with image bounds 1 to 2048");
    const deadline=AbortSignal.timeout(30000),signal=AbortSignal.any([deadline,...(outerSignal?[outerSignal]:[])]);
    const revision=this.executor.vault.credential(principal).revision;
    const check=()=>{
      if(signal.aborted)throw new BridgeError(deadline.aborted?"image_fetch_timeout":"image_cancelled",deadline.aborted?"Image retrieval exceeded 30 seconds":"Image retrieval was cancelled");
      if(this.executor.vault.credential(principal).revision!==revision)throw new BridgeError("credential_conflict","Credential changed during image retrieval");
    };
    const run=async(call:ApiCall,maxResponseBytes?:number)=>{
      check();this.permit(call.operation_id);
      const before=performance.now();
      const result=await this.executor.call(principal,call,this.control.resolver(principal,call.operation_id),{signal,maxResponseBytes});
      timings[call.operation_id]=Math.round((performance.now()-before)*1000)/1000;check();
      if(result.state!=="completed"||result.upstream?.status!==200||!result.result_ref)
        throw new BridgeError("image_upstream_failed","Image request was refused or incomplete"+(result.upstream?" (HTTP "+result.upstream.status+")":""));
      return result;
    };
    try{
      check();let assetId=input.asset_id;
      if(input.source==="random"){
        const found=await run({operation_id:"searchRandom",body:{size:1,filter:{type:{eq:"IMAGE"}},withExif:false,withPeople:false},content_type:"application/json"});
        if(!Array.isArray(found.data)||found.data.length!==1||found.data[0]?.type!=="IMAGE"||!uuid.test(found.data[0]?.id??""))throw new BridgeError("image_not_found","No accessible image was found");
        assetId=found.data[0].id;
      }
      const fetched=await run({operation_id:"viewAsset",path:{id:assetId},query:{size:"preview"}},32*1024*1024);
      const before=performance.now();
      const result=await this.images.read(principal,{result_ref:fetched.result_ref!,...(input.max_width!==undefined?{max_width:input.max_width}:{}),
        ...(input.max_height!==undefined?{max_height:input.max_height}:{}),...(input.format?{format:input.format}:{})}as ImageInput,signal);
      const info=imageMetadata(result);imageRequestId=info.request_id;timings.image_read=Math.round((performance.now()-before)*1000)/1000;check();code="ok";
      const meta={...info,asset_id:assetId!};
      return {...result,content:[result.content[0]!,{type:"text"as const,text:imageSummary(meta)}],_meta:{...result._meta,image_info:meta}};
    }catch(error){
      if(signal.aborted){code=deadline.aborted?"image_fetch_timeout":"image_cancelled";throw new BridgeError(code,deadline.aborted?"Image retrieval exceeded 30 seconds":"Image retrieval was cancelled");}
      code=error instanceof BridgeError?error.code:"image_failed";throw error;
    }finally{
      try{this.trace({event:"image_fetch",request_id:traceId,image_request_id:imageRequestId,code,timings_ms:timings,total_ms:Math.round((performance.now()-started)*1000)/1000});}catch{}
    }
  }
}
