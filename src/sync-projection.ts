import mapping from "../contracts/sync-records.v3.3.5.json" with {type:"json"};
import { registry } from "./registry.js";
import { JsonLines } from "./jsonl.js";
import { validator,assertSafeNumbers } from "./schema.js";
import { safeShape,redact } from "./projection.js";
import { BridgeError } from "./types.js";
import { ResultPages,type PagedProjection } from "./result-pages.js";
import { Vault } from "./vault.js";
if(mapping.source_commit!==registry.commit||mapping.openapi_sha256!==registry.sha256)throw Error("Sync record source fingerprint mismatch");
const schemas=mapping.record_schemas as Record<string,string>;
const checks=new Map<string,ReturnType<typeof validator>>();
export class SyncProjection {
  readonly pages:ResultPages;
  private parser:JsonLines;private terminal:string|null=null;private error:string|null=null;
  constructor(vault:Vault,principal:string,readonly saveSecret:(value:string)=>string,expires=Date.now()+3600_000){
    this.pages=new ResultPages(vault,principal,expires);
    this.parser=new JsonLines(1024*1024,record=>this.accept(record));
  }
  private accept(record:any){
    if(this.terminal)throw new BridgeError("records_after_terminal","Unexpected record after stream terminal");
    if(!record||Array.isArray(record)||typeof record!=="object"||Object.keys(record).some(k=>!["type","data","ack"].includes(k))||
      typeof record.type!=="string"||typeof record.ack!=="string"||!Object.hasOwn(record,"data"))
      throw new BridgeError("invalid_sync_record","Unexpected sync record envelope");
    const name=schemas[record.type];
    if(!name||!Object.hasOwn(registry.schemas,name))throw new BridgeError("unknown_sync_record","Unknown sync record type");
    let check=checks.get(name);if(!check){check=validator(registry.schemas[name]!,registry.schemas);checks.set(name,check);}
    check(record.data);assertSafeNumbers(record);
    const display={type:record.type,data:safeShape(record.data,registry.schemas[name]!,0,()=>({withheld:true,reason:"unreviewed_structure",original_available_in_control_ui:true})),ack:record.ack};
    this.pages.append(redact("getSyncStream",200,display,this.saveSecret,true));
    if(record.type==="SyncCompleteV1"||record.type==="SyncResetV1")this.terminal=record.type;
  }
  push(chunk:Uint8Array){
    if(this.error)return;
    try{this.parser.push(chunk);}catch(error){this.error=error instanceof BridgeError?error.code:"jsonl_projection_failed";}
  }
  finish(interrupted=false):PagedProjection{
    if(!this.error){
      try{this.parser.finish();if(!this.terminal)throw new BridgeError("missing_stream_terminal","JSONL stream ended without a terminal record");}
      catch(error){this.error=error instanceof BridgeError?error.code:"jsonl_projection_failed";}
    }
    if(interrupted)this.error="response_interrupted";
    this.pages.flush();
    return {kind:"jsonl",stream_id:this.pages.streamId,total_records:this.pages.count,complete:!this.error,terminal:this.terminal,error:this.error};
  }
}
