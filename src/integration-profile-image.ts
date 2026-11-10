import { BridgeError } from "./types.js";

function fail():never{throw new BridgeError("fixture_profile_image","Invalid or unsupported fixture profile image");}
export interface ProfileImageFrame {format:"jpeg"|"webp";width:number;height:number;}
const dimensions=(format:ProfileImageFrame["format"],width:number,height:number):ProfileImageFrame=>{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096)fail();
  return {format,width,height};
};
// Bounded container/frame inspection, not an entropy/pixel decoder. Browser tests
// independently decode the frozen encoder oracle and actual native-harness output.
export function profileImageFrame(bytes:Buffer,mime:string):ProfileImageFrame{
  if(bytes.length<20||bytes.length>1024*1024)fail();
  if(mime==="image/jpeg"){
    if(bytes.readUInt16BE(0)!==0xffd8)fail();
    let at=2,frame:ProfileImageFrame|undefined,scans=0;
    while(at<bytes.length){
      if(bytes[at++]!==0xff)fail();
      while(bytes[at]===0xff)at++;
      const marker=bytes[at++];if(marker===undefined||marker===0||marker===0xd8)fail();
      if(marker===0xd9){if(at!==bytes.length||!frame||!scans)fail();return frame;}
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)fail();
      if(at+2>bytes.length)fail();const length=bytes.readUInt16BE(at),end=at+length;
      if(length<2||end>bytes.length)fail();
      if([0xc0,0xc1,0xc2].includes(marker)){
        if(frame||length<8||bytes[at+2]!==8)fail();
        const channels=bytes[at+7];if(![1,3].includes(channels!)||length!==8+3*channels!)fail();
        frame=dimensions("jpeg",bytes.readUInt16BE(at+5),bytes.readUInt16BE(at+3));
      }else if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))fail();
      at=end;
      if(marker===0xda){
        if(!frame||length<6)fail();scans++;let found=false;
        while(at<bytes.length){
          if(bytes[at++]!==0xff)continue;
          const start=at-1;while(bytes[at]===0xff)at++;
          const next=bytes[at];if(next===undefined)fail();
          if(next===0||next>=0xd0&&next<=0xd7){at++;continue;}
          at=start;found=true;break;
        }
        if(!found)fail();
      }
    }
    return fail();
  }
  if(mime!=="image/webp"||bytes.toString("ascii",0,4)!=="RIFF"||bytes.toString("ascii",8,12)!=="WEBP"||bytes.readUInt32LE(4)!==bytes.length-8)fail();
  let at=12,frame:ProfileImageFrame|undefined,extended:ProfileImageFrame|undefined;
  while(at<bytes.length){
    if(at+8>bytes.length)fail();const kind=bytes.toString("ascii",at,at+4),length=bytes.readUInt32LE(at+4),start=at+8,end=start+length;
    if(end>bytes.length||end+(length&1)>bytes.length||length&1&&bytes[end]!==0)fail();
    if(kind==="ANIM"||kind==="ANMF")fail();
    if(kind==="VP8X"){
      if(extended||frame||at!==12||length!==10||(bytes[start]!&2)!==0)fail();
      extended=dimensions("webp",1+bytes.readUIntLE(start+4,3),1+bytes.readUIntLE(start+7,3));
    }else if(kind==="VP8 "){
      if(frame||length<10||(bytes[start]!&1)!==0||bytes.toString("hex",start+3,start+6)!=="9d012a")fail();
      frame=dimensions("webp",bytes.readUInt16LE(start+6)&0x3fff,bytes.readUInt16LE(start+8)&0x3fff);
    }else if(kind==="VP8L"){
      if(frame||length<5||bytes[start]!==0x2f)fail();const packed=bytes.readUInt32LE(start+1);
      if(packed>>>29)fail();frame=dimensions("webp",1+(packed&0x3fff),1+((packed>>>14)&0x3fff));
    }
    at=end+(length&1);
  }
  if(!frame||extended&&(frame.width!==extended.width||frame.height!==extended.height))fail();
  return frame;
}
