import { BridgeError } from "./types.js";
// The pinned controller terminates every record with a newline. Missing final
// newline is kept distinct from clean EOF, including when the JSON is parseable.
export class JsonLines {
  private decoder=new TextDecoder("utf-8",{fatal:true});
  private pending="";
  private ended=false;
  constructor(readonly maxLineBytes=1024*1024,readonly onRecord?:(record:any)=>void) {}
  push(chunk:Uint8Array):any[] {
    if(this.ended)throw new BridgeError("stream_closed","JSONL parser already finished");
    try {this.pending+=this.decoder.decode(chunk,{stream:true});}
    catch{throw new BridgeError("invalid_utf8","Invalid UTF-8 in JSONL");}
    const records:any[]=[];
    let index:number;
    while((index=this.pending.indexOf("\n"))>=0){
      const line=this.pending.slice(0,index).replace(/\r$/,"");this.pending=this.pending.slice(index+1);
      if(Buffer.byteLength(line)>this.maxLineBytes)throw new BridgeError("line_limit","JSONL line exceeds resource limit");
      if(!line.trim())continue;
      let record:any;
      try{record=JSON.parse(line);}catch{throw new BridgeError("invalid_jsonl","Invalid JSONL record");}
      if(this.onRecord)this.onRecord(record);else records.push(record);
    }
    if(Buffer.byteLength(this.pending)>this.maxLineBytes)throw new BridgeError("line_limit","JSONL line exceeds resource limit");
    return records;
  }
  finish() {
    this.ended=true;
    try{this.pending+=this.decoder.decode();}catch{throw new BridgeError("invalid_utf8","Truncated UTF-8 at EOF");}
    if(this.pending.length)throw new BridgeError("incomplete_jsonl","JSONL stream ended before a record terminator");
  }
}
