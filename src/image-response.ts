import { BridgeError } from "./types.js";

export const imageToolNames=new Set(["immich_read_image","immich_get_image"]);
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
