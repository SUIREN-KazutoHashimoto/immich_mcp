const mode=process.argv[2] ?? "live";
let ok=false;
try{
  if(!["live","ready"].includes(mode))throw Error();
  const text=process.env.MCP_LISTEN_PORT ?? "3000",port=Number(text);
  if(!/^[0-9]+$/.test(text)||!Number.isInteger(port)||port<1||port>65535)throw Error();
  const response=await fetch("http://127.0.0.1:"+port+"/health/"+mode,{redirect:"error",signal:AbortSignal.timeout(4000)});
  const reader=response.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192)throw Error();chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=Buffer.concat(chunks),body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  ok=response.status===200&&body[mode]===true;
}catch{}
console.log(JSON.stringify({check:["live","ready"].includes(mode)?mode:"invalid",ok}));process.exitCode=ok?0:1;
export {};
