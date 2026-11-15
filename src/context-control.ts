import { referenceReceipt } from "./control-ui.js";
import { Contexts,type ContextKind } from "./contexts.js";
import type { Resolver } from "./serializer.js";
import { BridgeError } from "./types.js";
const esc=(v:any)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export class ContextControl {
  constructor(readonly contexts:Contexts,readonly resolver:(principal:string,operation:string,context:string)=>Resolver) {}
  render(principal:string,token:string) {
    const hidden=(ref:string,generation:number)=>'<input type="hidden" name="csrf" value="'+esc(token)+'"><input type="hidden" name="context_ref" value="'+esc(ref)+'"><input type="hidden" name="generation" value="'+generation+'">';
    return '<details class="panel"><summary><span class="summary-icon" aria-hidden="true">＋</span><span>セッション・共有リンクなどの追加認証<small>通常のAPIキーで扱えない操作が必要な場合に設定します</small></span></summary><div class="details-content"><p class="notice">この接続にはAPIキーの権限制限は適用されません。通常のAPIキー接続から自動的に切り替わることはありません。</p>'+
      '<form method="post" action="/connect/context/register"><input type="hidden" name="csrf" value="'+esc(token)+'">'+
      '<label>接続の種類 <select name="kind"><option value="public">公開操作・初期設定</option><option value="session">セッションの専用操作</option><option value="shared_link">共有リンク</option><option value="maintenance">メンテナンス</option></select></label>'+
      '<label>セッション・共有リンク・メンテナンスの認証情報 <input type="password" name="credential" autocomplete="off"></label>'+
      '<label>取得済みの結果から読み込む場合の参照ID（任意） <input name="source_result_ref" autocomplete="off"></label>'+
      '<label>共有リンクの識別方法 <select name="share_type"><option value="">該当しない</option><option value="key">キー</option><option value="slug">短縮ID（slug）</option></select></label>'+
      '<label>有効期間<select name="ttl_seconds"><option value="900">15分</option><option value="3600" selected>1時間</option><option value="14400">4時間</option><option value="86400">24時間</option></select></label>'+
      '<label class="check"><input type="checkbox" name="acknowledge" value="1" required> この追加認証にはAPIキーの権限制限が引き継がれないことを理解しました。</label><button>追加認証を登録</button></form>'+
      this.contexts.list(principal).map(c=>'<section class="record"><p><code>'+esc(c.context_ref)+'</code> '+esc(({session:"セッション",public:"公開操作",shared_link:"共有リンク",maintenance:"メンテナンス"})[c.kind])+' / '+esc(c.mode==="general_session"?"一般操作":"専用操作")+
        (c.enabled?(c.requires_revalidation?' / 本人の再確認が必要':' / 接続済み'):' / 解除済み')+'</p>'+
        (c.enabled?'<form method="post" action="/connect/context/revoke">'+hidden(c.context_ref,c.generation)+'<button>この追加認証を解除</button></form>':"")+
        (c.enabled&&c.kind==="session"?'<form method="post" action="/connect/context/revalidate">'+hidden(c.context_ref,c.generation)+'<button>現在のAPIキーで本人を再確認</button></form>'+
          '<form method="post" action="/connect/context/mode">'+hidden(c.context_ref,c.generation)+
          '<label>セッションの利用範囲 <select name="general"><option value="0"'+(c.mode==="special"?' selected':"")+'>セッションの専用操作のみ</option><option value="1"'+(c.mode==="general_session"?' selected':"")+'>一般操作・PIN保護された写真の操作</option></select></label>'+
          '<label class="check"><input type="checkbox" name="acknowledge" value="1" required> APIキーの権限制限が適用されない、独立した認証モードを明示的に選択します。</label><button>利用範囲を保存</button></form>':"")+
        (c.enabled&&c.kind==="public"?'<form method="post" action="/connect/context/oauth">'+hidden(c.context_ref,c.generation)+'<button>ImmichのOAuthログインを開始</button></form>':"")+'</section>').join("")+'</div></details>';
  }
  callback(principal:string,url:string) {
    const receipt=this.contexts.acceptOAuthCallback(principal,url);
    return referenceReceipt("OAuthの応答を受け取りました","同じ追加認証で、この参照IDを指定してログインを完了してください。",receipt.callback_ref,"認証コードは非公開のまま保持されます。必要な操作はChatGPTから案内された手順に従ってください。");
  }
  async action(principal:string,path:string,form:URLSearchParams) {
    const one=(name:string,optional=false)=>{const values=form.getAll(name);if(values.length>1||!optional&&values.length!==1)throw new BridgeError("invalid_input","Missing or duplicate context field");return values[0] ?? "";};
    if(path==="/connect/context/register"){
      const kind=one("kind") as ContextKind,credential=one("credential",true),source=one("source_result_ref",true),share=one("share_type",true);
      const c=await this.contexts.register(principal,{kind,acknowledge:one("acknowledge",true)==="1",ttl_seconds:Number(one("ttl_seconds")),
        ...(credential?{credential}:{}),...(source?{source_result_ref:source}:{}),...(share?{share_type:share as "key"|"slug"}:{})});
      return {body:referenceReceipt("追加の認証を登録しました","この参照IDを指定して、対応する操作を利用できます。",c.context_ref,"この接続にはAPIキーの権限制限が引き継がれません。通常の接続が自動的に置き換わることはありません。")};
    }
    const ref=one("context_ref"),generation=Number(one("generation"));
    if(!Number.isSafeInteger(generation)||generation<1)throw new BridgeError("invalid_input","Invalid context generation");
    if(path==="/connect/context/revoke")this.contexts.revoke(principal,ref,generation);
    else if(path==="/connect/context/revalidate")await this.contexts.revalidate(principal,ref,generation);
    else if(path==="/connect/context/mode"){
      const mode=one("general");if(!["0","1"].includes(mode))throw new BridgeError("invalid_input","Unknown session mode");
      this.contexts.setSessionMode(principal,ref,generation,mode==="1",one("acknowledge",true)==="1");
    }else if(path==="/connect/context/oauth"){
      this.contexts.check(principal,ref,generation);
      return {redirect:await this.contexts.beginOAuth(principal,ref,this.resolver(principal,"startOAuth",ref))};
    }else throw new BridgeError("invalid_input","Unknown context action");
    return {redirect:"/connect"};
  }
}
