import { crc32 } from "node:zlib";
import { BridgeError } from "./types.js";

export interface FixtureZipEntry {name:string;bytes:Buffer;crc32:number;}
const invalid=():never=>{throw new BridgeError("fixture_zip_shape","Synthetic archive framing, membership or checksum is invalid");};
// Only the small STORE archives produced for this plan are inspected. Production
// byte transport remains independent and supports opaque archives of any format.
export function fixtureStoredZip(bytes:Buffer):FixtureZipEntry[]{
  if(bytes.length<22||bytes.length>2*1024*1024)invalid();
  const end=bytes.length-22;
  if(bytes.readUInt32LE(end)!==0x06054b50||bytes.readUInt16LE(end+20)!==0||
    bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)invalid();
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
  if(!count||count>32||count!==bytes.readUInt16LE(end+8)||offset+size!==end)invalid();
  const within=(start:number,length:number,limit:number)=>{if(start<0||length<0||start+length>limit)invalid();};
  const extras=(start:number,length:number)=>{
    const stop=start+length;within(start,length,end);while(start<stop){
      within(start,4,stop);const kind=bytes.readUInt16LE(start),len=bytes.readUInt16LE(start+2);
      if(kind===1)invalid();within(start+4,len,stop);start+=4+len;
    }
  };
  const entries:FixtureZipEntry[]=[],ranges:{start:number;end:number}[]=[],names=new Set<string>();let cursor=offset,total=0;
  for(let n=0;n<count;n++){
    within(cursor,46,end);if(bytes.readUInt32LE(cursor)!==0x02014b50)invalid();
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),
      compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24),nameLen=bytes.readUInt16LE(cursor+28),
      extraLen=bytes.readUInt16LE(cursor+30),commentLen=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    if(flags&~0x0808||method!==0||compressed!==length||length>256*1024||!nameLen||nameLen>1024||
      bytes.readUInt16LE(cursor+34)!==0||commentLen!==0)invalid();
    within(cursor,46+nameLen+extraLen,end);const encoded=bytes.subarray(cursor+46,cursor+46+nameLen);
    let name:string;try{name=new TextDecoder("utf-8",{fatal:true}).decode(encoded);}catch{invalid();}
    if(!(flags&0x0800)&&encoded.some(byte=>byte>127)||!name!||name!==name!.trim()||/[\\/\0:]/.test(name!)||name==="."||name===".."||names.has(name!))invalid();
    extras(cursor+46+nameLen,extraLen);names.add(name!);total+=length;if(total>1024*1024)invalid();
    within(local,30,offset);if(bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)invalid();
    const ln=bytes.readUInt16LE(local+26),le=bytes.readUInt16LE(local+28);within(local,30+ln+le,offset);
    if(ln!==nameLen||!bytes.subarray(local+30,local+30+ln).equals(encoded))invalid();extras(local+30+ln,le);
    const start=local+30+ln+le,stop=start+length;within(start,length,offset);
    let rangeEnd=stop;
    if(flags&8){
      const candidates=[false,true].filter(signature=>{
        const pos=stop+(signature?4:0),len=signature?16:12;
        return stop+len<=offset&&(!signature||bytes.readUInt32LE(stop)===0x08074b50)&&
          bytes.readUInt32LE(pos)===crc&&bytes.readUInt32LE(pos+4)===compressed&&bytes.readUInt32LE(pos+8)===length;
      });
      if(candidates.length!==1)invalid();rangeEnd+=candidates[0]?16:12;
      for(const [at,value] of [[14,crc],[18,compressed],[22,length]]){const v=bytes.readUInt32LE(local+at!);if(v!==0&&v!==value)invalid();}
    }else if(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length)invalid();
    const data=bytes.subarray(start,stop);if(crc32(data)!==crc)invalid();
    ranges.push({start:local,end:rangeEnd});entries.push({name:name!,bytes:data,crc32:crc});cursor+=46+nameLen+extraLen;
  }
  if(cursor!==end)invalid();ranges.sort((a,b)=>a.start-b.start);let last=0;
  for(const range of ranges){if(range.start!==last)invalid();last=range.end;}if(last!==offset)invalid();
  return entries;
}
