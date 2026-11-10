const button=document.getElementById("upload-button");
if(button){
  const output=document.getElementById("upload-status");
  const storageKey="immich-upload:"+output.dataset.connection;
  const csrf=()=>document.querySelector('input[name="csrf"]').value;
  const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
  const digest=async bytes=>hex(await crypto.subtle.digest("SHA-256",bytes));
  const api=async(path,body,method="POST")=>{
    const response=await fetch(path,{method,credentials:"same-origin",headers:method==="POST"?{"X-CSRF-Token":csrf(),"Content-Type":body instanceof ArrayBuffer?"application/octet-stream":"application/json"}:{},
      ...(method==="POST"?{body:body instanceof ArrayBuffer?body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error?.code ?? "upload_failed");
    return value;
  };
  button.addEventListener("click",async()=>{
    button.disabled=true;
    try{
      const file=document.getElementById("upload-file").files[0];
      if(!file)throw new Error("Select a file first");
      const sha256=document.getElementById("upload-sha256").value.trim().toLowerCase();
      let saved;try{saved=JSON.parse(localStorage.getItem(storageKey) ?? "null");}catch{saved=null;}
      const identity={name:file.name,size:file.size,modified:file.lastModified,sha256};
      let state;
      if(saved && JSON.stringify(saved.identity)!==JSON.stringify(identity))throw new Error("An interrupted upload exists. Resume the original file or discard it first");
      if(saved && JSON.stringify(saved.identity)===JSON.stringify(identity)){
        state=await api("/connect/upload/status?ref="+encodeURIComponent(saved.ref),undefined,"GET");
        if(state.state==="aborted")state=null;
      }
      if(!state){
        state=await api("/connect/upload/start",{filename:file.name,mime:file.type || "application/octet-stream",size:file.size,...(sha256?{sha256}:{})});
        localStorage.setItem(storageKey,JSON.stringify({identity,ref:state.upload_ref}));
      }
      // Re-read and hash received chunks to prove that a reselected file is the same file.
      for(const chunk of state.chunks){
        const start=chunk.index*state.chunk_bytes;
        const bytes=await file.slice(start,start+chunk.size).arrayBuffer();
        if(await digest(bytes)!==chunk.sha256)throw new Error("Selected file differs from the interrupted upload");
      }
      if(state.state==="completed"){
        output.textContent=JSON.stringify(state.file,null,2);localStorage.removeItem(storageKey);return;
      }
      let offset=state.received_bytes,index=state.next_chunk;
      while(offset<file.size){
        const bytes=await file.slice(offset,Math.min(file.size,offset+state.chunk_bytes)).arrayBuffer();
        const sha=await digest(bytes);
        state=await api("/connect/upload/chunk?ref="+encodeURIComponent(state.upload_ref)+"&index="+index+"&sha256="+sha,bytes);
        offset=state.received_bytes;index=state.next_chunk;
        output.textContent="Uploaded "+offset+" of "+file.size+" bytes";
      }
      const result=await api("/connect/upload/complete",{upload_ref:state.upload_ref});
      output.textContent=JSON.stringify(result,null,2);localStorage.removeItem(storageKey);
    }catch(error){output.textContent=error.message+". Select the same file and retry to resume.";}
    finally{button.disabled=false;}
  });
  document.getElementById("upload-discard").addEventListener("click",async()=>{
    try{
      const saved=JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if(saved)await api("/connect/upload/abort",{upload_ref:saved.ref});
      localStorage.removeItem(storageKey);output.textContent="Interrupted upload discarded";
    }catch(error){output.textContent=error.message;}
  });
}
