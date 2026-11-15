import { controlStyle } from "./control-style.js";
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const mark='<svg viewBox="0 0 40 40" width="32" height="32" aria-hidden="true"><rect x="7" y="5" width="23" height="27" rx="6" fill="white" opacity=".35" transform="rotate(-12 19 19)"/><rect x="11" y="9" width="23" height="27" rx="6" fill="white"/><circle cx="25" cy="18" r="3" fill="#ee8374"/><path d="M14 30l6-8 4 5 3-3 5 6" fill="#8477cf"/></svg>';
export const controlSecurity={"cache-control":"no-store","x-content-type-options":"nosniff",
  "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy":"no-referrer"};
export function controlPage(body:string,cookie?:string,status=200){
  return new Response('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接続設定 · Immich MCP</title><style>'+controlStyle+'</style></head><body><header class="topbar"><div class="topbar-inner"><a class="brand" href="/connect"><span class="brand-icon">'+mark+'</span>Immich MCP</a><span class="topbar-note">あなたのアカウントの接続設定</span></div></header><main>'+body+'<footer class="footer">Immich MCP · 認証済みの利用者専用ページ</footer></main></body></html>',
    // Native forms need same-origin Origin; suppress cross-origin referrers.
    {status,headers:{...controlSecurity,"referrer-policy":"same-origin","content-type":"text/html; charset=utf-8",...(cookie?{"set-cookie":cookie}:{})}});
}
export function statusLabel(s:string){return ({active:"登録済み",unregistered:"未登録",disconnected:"登録解除済み",revoked:"再登録が必要",invalid:"再登録が必要",suspended:"一時停止中",queued:"実行待ち",running:"実行中",completed:"完了",failed:"失敗",cancel_requested:"停止を依頼済み",cancelled:"停止済み",outcome_unknown:"結果の確認が必要"}as Record<string,string>)[s]??"状態を確認してください";}
export function formatBytes(bytes:number){const n=Math.max(0,Number.isFinite(bytes)?bytes:0);return n>=1073741824?(n/1073741824).toFixed(1)+" GB":n>=1048576?(n/1048576).toFixed(1)+" MB":n>=1024?(n/1024).toFixed(1)+" KB":n+" B";}
export function referenceReceipt(title:string,description:string,ref:string,notice="この参照IDだけをChatGPTに伝えてください。入力した秘密値は表示されません。"){
  return '<div class="receipt"><section class="card"><div class="receipt-symbol" aria-hidden="true">✓</div><p class="eyebrow">設定を保存しました</p><h1>'+escape(title)+'</h1><p>'+escape(description)+'</p><div class="reference"><code>'+escape(ref)+'</code></div><p>'+escape(notice)+'</p><a class="button" href="/connect">接続設定に戻る</a></section></div>';
}
export function connectionView(i:{state:string;label:string;used:number;quota:number;keyHidden:string;secretHidden:string;contexts:string;uploads:boolean;principal:string;jobs:string;results:string;restore:boolean}){
  const active=i.state==="active",bytes=formatBytes(i.used)+" / "+formatBytes(i.quota);
  return '<div class="hero"><p class="eyebrow">接続設定</p><h1>Immichと、つながる。</h1><p>APIキーを登録して、ChatGPTからあなたの写真を探せるようにしましょう。</p></div>'+
  (i.restore?'<div class="notice" role="status">バックアップから復元されました。復元時点で未完了だった処理は、実行結果を確認するまで保留されます。追加の認証は接続し直してください。</div>':"")+
  '<div class="layout"><section class="card" id="api-key" aria-labelledby="key-title"><div class="card-heading"><div><h2 id="key-title">Immich APIキー</h2><p>あなたのImmichアカウントと接続します。</p></div><span class="badge '+(active?"good":i.state==="unregistered"?"":"warning")+'">'+escape(statusLabel(i.state))+'</span></div><form method="post" action="/connect/key">'+i.keyHidden+
  '<label for="immich-api-key">APIキー<input id="immich-api-key" type="password" name="key" required autocomplete="off" placeholder="APIキーを入力" aria-describedby="key-hint"></label><p class="hint" id="key-hint">Immichのアカウント設定で発行したキーを入力してください。'+(active?'登録済みのキーを更新する場合は、新しいキーを入力します。':"")+'</p><div class="actions"><button type="submit">確認して保存</button></div></form><p class="trust">キーは暗号化して保存され、画面やチャットに表示されません。</p>'+
  '<details class="subtle-details"><summary>保存領域・接続の詳細</summary><div><div class="connection-details"><span>保存データの使用量</span><span>'+escape(bytes)+'</span></div><progress class="meter" aria-label="保存データの使用率" value="'+Math.min(i.used,i.quota)+'" max="'+i.quota+'"></progress><p class="muted">有効期限を過ぎた一時データは自動で削除されます。</p><p class="muted">接続ラベル <code>'+escape(i.label)+'</code></p>'+
  (i.state!=="unregistered"?'<form method="post" action="/connect/disconnect">'+i.keyHidden+'<p class="muted">このMCPに保存したAPIキーの登録を解除します。Immich側のAPIキー自体は削除されません。</p><button class="danger" type="submit">APIキーの登録を解除</button></form>':"")+'</div></details></section>'+
  '<aside class="card guide" aria-labelledby="guide-title"><h2 id="guide-title">接続するには</h2><ol class="steps"><li><span class="step-number">1</span><span><strong>Immichでキーを発行</strong>アカウント設定からAPIキーを作成します。</span></li><li><span class="step-number">2</span><span><strong>この画面で登録</strong>キーを入力し、確認して保存します。</span></li><li><span class="step-number">3</span><span><strong>ChatGPTから利用</strong>写真の検索や表示を依頼できます。</span></li></ol><p class="guide-note">利用できる操作は、ImmichでAPIキーに付与した権限に従います。秘密の値をチャットへ貼り付ける必要はありません。</p></aside></div>'+
  '<section class="settings" aria-labelledby="more-title"><h2 id="more-title">必要に応じて設定</h2>'+i.contexts+
  '<details class="panel"><summary><span class="summary-icon" aria-hidden="true">＊</span><span>パスワード・トークンの受け渡し<small>秘密の値を、チャットに貼らずに渡します</small></span></summary><div class="details-content"><p class="muted">ChatGPTから案内された操作名と入力先を指定してください。保存すると、秘密の値を含まない参照IDを発行します。</p><form method="post" action="/connect/secret">'+i.secretHidden+
  '<div class="form-grid"><label>操作名（Operation ID）<input name="operation_id" required placeholder="login" autocomplete="off"></label><label>入力先（JSON Pointer）<input name="pointer" required placeholder="/password" autocomplete="off"></label>'+
  (i.contexts?'<label class="full">追加認証の参照ID（利用する場合のみ）<input name="context_ref" autocomplete="off" placeholder="context_…"></label>':"")+
  '<label class="full">パスワード・トークンなど<input type="password" name="value" autocomplete="off"></label></div><p class="hint">空の値を受け付ける操作では、空欄のまま登録できます。</p><button type="submit">参照IDを発行</button></form></div></details>'+
  (i.uploads?'<details class="panel" id="upload-panel"><summary><span class="summary-icon" aria-hidden="true">↑</span><span>ファイルのアップロード<small>中断した場合も、同じファイルから再開できます</small></span></summary><div class="details-content"><p class="muted">アップロード後に発行される参照IDを、ChatGPTからの操作に利用できます。</p><label>アップロードするファイル<input type="file" id="upload-file"></label><details class="subtle-details"><summary>整合性の確認（任意）</summary><div><label>期待するSHA-256<input id="upload-sha256" autocomplete="off" placeholder="確認用のハッシュ値"></label></div></details><div class="actions"><button id="upload-button" type="button">アップロード・再開</button><button class="secondary" id="upload-discard" type="button">中断データを破棄</button></div><pre id="upload-status" role="status" aria-live="polite" data-connection="'+escape(i.principal)+'"></pre><script src="/connect/upload.js" defer></script></div></details>':"")+
  '<details class="panel"><summary><span class="summary-icon" aria-hidden="true">↗</span><span>最近の処理と取得結果<small>処理の状態や、取得済みファイルを確認します</small></span></summary><div class="details-content"><p class="muted">応答が途切れた場合は、同じ操作を繰り返す前に、ここで既存の処理を確認してください。</p><h3>最近の処理</h3>'+(i.jobs||'<p class="empty">まだ処理はありません。</p>')+'<h3 style="margin-top:23px">取得済みの結果</h3><p class="muted">原本には認証情報などが含まれる場合があります。ダウンロードしたファイルの取り扱いにご注意ください。</p>'+(i.results||'<p class="empty">有効な取得結果はありません。</p>')+'</div></details></section>';
}
export function controlError(code:string,status:number){
  const messages:Record<string,[string,string]>={
    unauthenticated:["ログインを確認してください","認証の有効期限が切れた可能性があります。ログインし直してから、もう一度お試しください。"],
    csrf:["画面を開き直してください","安全確認の有効期限が切れたか、フォームを確認できませんでした。接続設定を開き直して入力してください。"],
    invalid_origin:["この操作を確認できませんでした","接続設定の画面から、もう一度操作してください。"],
    key_validation_failed:["APIキーを確認してください","ImmichがこのAPIキーを受け付けませんでした。キーの内容と有効性を確認してください。"],
    credential_conflict:["接続設定が更新されています","別の画面で接続が変更された可能性があります。画面を開き直してから操作してください。"],
    invalid_secret_binding:["入力先を確認してください","この操作名と入力先は、秘密情報の登録先として利用できません。ChatGPTから案内された値を確認してください。"],
    invalid_input:["入力内容を確認してください","必要な項目が未入力か、入力形式を確認できませんでした。"],
    storage_unavailable:["保存先を確認できません","しばらく待ってからお試しください。解消しない場合は管理者にご連絡ください。"]};
  const [title,description]=messages[code]??["操作を完了できませんでした","画面を開き直してお試しください。解消しない場合は、下のエラーコードを管理者にお伝えください。"];
  return controlPage('<div class="receipt"><section class="card"><p class="eyebrow">接続設定</p><h1>'+escape(title)+'</h1><p>'+escape(description)+'</p><p class="muted">エラーコード <code>'+escape(code)+'</code></p><a class="button" href="/connect">接続設定に戻る</a></section></div>',undefined,status);
}
