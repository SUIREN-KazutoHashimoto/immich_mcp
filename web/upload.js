const button=document.getElementById("upload-button");
if(button){
  const output=document.getElementById("upload-status");
  const storageKey="immich-upload:"+output.dataset.connection;
  const complete=file=>{
    output.dataset.state="completed";output.dataset.file=JSON.stringify(file);
    output.textContent="アップロードが完了しました。\n\n参照ID: "+file.file_ref+"\nファイル名: "+(file.file_name??file.filename??"ファイル")+"\nこの参照IDをChatGPTに伝えてください。";
  };
  const csrf=()=>document.querySelector('input[name="csrf"]').value;
  const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
  const digest=async bytes=>hex(await crypto.subtle.digest("SHA-256",bytes));
  const api=async(path,body,method="POST")=>{
    const response=await fetch(path,{method,credentials:"same-origin",headers:method==="POST"?{"X-CSRF-Token":csrf(),"Content-Type":body instanceof ArrayBuffer?"application/octet-stream":"application/json"}:{},
      ...(method==="POST"?{body:body instanceof ArrayBuffer?body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok)throw new Error(({csrf:"安全確認の有効期限が切れています。画面を開き直してください。",unauthenticated:"ログインの有効期限が切れています。",storage_quota:"保存領域が不足しています。",invalid_upload:"アップロード内容を確認できませんでした。"})[value.error?.code] ?? "アップロードを完了できませんでした。");
    return value;
  };
  button.addEventListener("click",async()=>{
    button.disabled=true;delete output.dataset.file;output.dataset.state="uploading";output.textContent="アップロードを準備しています…";
    try{
      const file=document.getElementById("upload-file").files[0];
      if(!file)throw new Error("ファイルを選択してください");
      const sha256=document.getElementById("upload-sha256").value.trim().toLowerCase();
      let saved;try{saved=JSON.parse(localStorage.getItem(storageKey) ?? "null");}catch{saved=null;}
      const identity={name:file.name,size:file.size,modified:file.lastModified,sha256};
      let state;
      if(saved && JSON.stringify(saved.identity)!==JSON.stringify(identity))throw new Error("中断したアップロードがあります。同じファイルで再開するか、中断データを破棄してください");
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
        if(await digest(bytes)!==chunk.sha256)throw new Error("選択したファイルの内容が、中断したファイルと異なります");
      }
      if(state.state==="completed"){
        complete(state.file);localStorage.removeItem(storageKey);return;
      }
      let offset=state.received_bytes,index=state.next_chunk;
      while(offset<file.size){
        const bytes=await file.slice(offset,Math.min(file.size,offset+state.chunk_bytes)).arrayBuffer();
        const sha=await digest(bytes);
        state=await api("/connect/upload/chunk?ref="+encodeURIComponent(state.upload_ref)+"&index="+index+"&sha256="+sha,bytes);
        offset=state.received_bytes;index=state.next_chunk;
        output.textContent="アップロード中: "+Math.floor(offset/file.size*100)+"%（"+offset+" / "+file.size+" B）";
      }
      const result=await api("/connect/upload/complete",{upload_ref:state.upload_ref});
      complete(result);localStorage.removeItem(storageKey);
    }catch(error){output.dataset.state="failed";output.textContent=(error instanceof TypeError?"通信が途切れました。":error.message)+" 同じファイルを選ぶと、続きから再開できます。";}
    finally{button.disabled=false;}
  });
  document.getElementById("upload-discard").addEventListener("click",async()=>{
    try{
      const saved=JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if(saved)await api("/connect/upload/abort",{upload_ref:saved.ref});
      localStorage.removeItem(storageKey);delete output.dataset.file;output.dataset.state="discarded";output.textContent="中断データを破棄しました";
    }catch(error){output.textContent=error.message;}
  });
}
