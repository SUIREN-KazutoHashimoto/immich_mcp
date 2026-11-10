import { Contexts,type ContextKind } from "./contexts.js";
import type { Resolver } from "./serializer.js";
import { BridgeError } from "./types.js";
const esc=(v:any)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export class ContextControl {
  constructor(readonly contexts:Contexts,readonly resolver:(principal:string,operation:string,context:string)=>Resolver) {}
  render(principal:string,token:string) {
    const hidden=(ref:string,generation:number)=>'<input type="hidden" name="csrf" value="'+esc(token)+'"><input type="hidden" name="context_ref" value="'+esc(ref)+'"><input type="hidden" name="generation" value="'+generation+'">';
    return '<h2>Additional authentication</h2><p>These contexts use Immich session, shared-link or maintenance authorization. API-key permissions do not apply. They never replace your normal API-key connection automatically.</p>'+
      '<form method="post" action="/connect/context/register"><input type="hidden" name="csrf" value="'+esc(token)+'">'+
      '<label>Context kind <select name="kind"><option value="public">Public / setup workflow</option><option value="session">Session workflow</option><option value="shared_link">Shared link</option><option value="maintenance">Maintenance runtime</option></select></label>'+
      '<label>Session / link / maintenance credential <input type="password" name="credential" autocomplete="off"></label>'+
      '<label>Or import from your result reference <input name="source_result_ref" autocomplete="off"></label>'+
      '<label>Shared-link credential <select name="share_type"><option value="">Not applicable</option><option value="key">Key</option><option value="slug">Slug</option></select></label>'+
      '<label>Lifetime in seconds <input type="number" name="ttl_seconds" min="60" max="86400" value="3600"></label>'+
      '<label><input type="checkbox" name="acknowledge" value="1" required> I understand that API-key permissions do not limit this additional context.</label><button>Connect context</button></form>'+
      this.contexts.list(principal).map(c=>'<section><p><code>'+esc(c.context_ref)+'</code> '+esc(c.kind)+' / '+esc(c.mode)+
        (c.enabled?(c.requires_revalidation?' / owner revalidation required':' / connected'):' / disconnected')+'</p>'+
        (c.enabled?'<form method="post" action="/connect/context/revoke">'+hidden(c.context_ref,c.generation)+'<button>Disconnect this context locally</button></form>':"")+
        (c.enabled&&c.kind==="session"?'<form method="post" action="/connect/context/revalidate">'+hidden(c.context_ref,c.generation)+'<button>Verify owner against current API key</button></form>'+
          '<form method="post" action="/connect/context/mode">'+hidden(c.context_ref,c.generation)+
          '<label>Session use <select name="general"><option value="0"'+(c.mode==="special"?' selected':"")+'>Session-specific workflows</option><option value="1"'+(c.mode==="general_session"?' selected':"")+'>General session / PIN-protected asset mode</option></select></label>'+
          '<label><input type="checkbox" name="acknowledge" value="1" required> I explicitly choose this separate authentication mode; API-key permissions do not apply.</label><button>Save session mode</button></form>':"")+
        (c.enabled&&c.kind==="public"?'<form method="post" action="/connect/context/oauth">'+hidden(c.context_ref,c.generation)+'<button>Start Immich OAuth login</button></form>':"")+'</section>').join("");
  }
  callback(principal:string,url:string) {
    const receipt=this.contexts.acceptOAuthCallback(principal,url);
    return '<h1>OAuth callback received</h1><p>Callback reference: <code>'+esc(receipt.callback_ref)+'</code></p>'+
      '<p>Return to connection settings to finish the workflow using this callback reference, or use it with the same context through MCP. The authorization code stays private.</p><p><a href="/connect">Connection settings</a></p>';
  }
  async action(principal:string,path:string,form:URLSearchParams) {
    const one=(name:string,optional=false)=>{const values=form.getAll(name);if(values.length>1||!optional&&values.length!==1)throw new BridgeError("invalid_input","Missing or duplicate context field");return values[0] ?? "";};
    if(path==="/connect/context/register"){
      const kind=one("kind") as ContextKind,credential=one("credential",true),source=one("source_result_ref",true),share=one("share_type",true);
      const c=await this.contexts.register(principal,{kind,acknowledge:one("acknowledge",true)==="1",ttl_seconds:Number(one("ttl_seconds")),
        ...(credential?{credential}:{}),...(source?{source_result_ref:source}:{}),...(share?{share_type:share as "key"|"slug"}:{})});
      return {body:'<h1>Context connected</h1><code>'+esc(c.context_ref)+'</code><p>'+esc(c.notice)+'</p><p><a href="/connect">Connection settings</a></p>'};
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
