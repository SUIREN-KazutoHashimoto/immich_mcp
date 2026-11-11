import { BridgeError } from "./types.js";

export const imageToolNames=new Set(["immich_read_image","immich_get_image"]);
export function imageMetadata(value:any):any {
  const result=imageEnvelope(value);return result?._meta?.image_info??result?.structuredContent;
}
export function imageSummary(meta:any){
  return "Prepared image "+meta.width+" x "+meta.height+" ("+meta.mime_type+"). result_ref="+meta.result_ref+
    "; request_id="+meta.request_id+(meta.asset_id?"; asset_id="+meta.asset_id:"")+"; display_status=unconfirmed. Display and visual recognition require separate confirmation.";
}
// Only unwrap documented result envelopes. Metadata is never an image substitute.
export function imageEnvelope(value:any):any {
  for(let depth=0;depth<5&&value&&typeof value==="object";depth++){
    if(Array.isArray(value.content))return value;
    value=value.mcp_tool_result??value.call_tool_result??value.result;
  }
  return undefined;
}
export function requireImageContent(value:any){
  const result=imageEnvelope(value);
  if(!result||result.isError||!result.content.some((part:any)=>part?.type==="image"&&typeof part.data==="string"&&part.data.length>0))
    throw new BridgeError("image_content_missing","No model-visible image content was received; metadata and UI display are not visual input");
  return result;
}
