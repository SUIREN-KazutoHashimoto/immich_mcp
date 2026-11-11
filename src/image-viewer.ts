import { readFileSync } from "node:fs";

export const IMAGE_VIEWER_URI="ui://immich/image-preview/v2.html";
export const LEGACY_IMAGE_VIEWER_URI="ui://immich/image-preview/v1.html";
export const IMAGE_VIEWER_MIME="text/html;profile=mcp-app";
export function imageViewerResource(uri=IMAGE_VIEWER_URI){
  return {
    uri,mimeType:IMAGE_VIEWER_MIME,
    text:readFileSync(new URL("../web/image-viewer.html",import.meta.url),"utf8"),
    _meta:{
      ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
      "openai/widgetDescription":"認証済みのImmich画像を表示し、その画像の説明を依頼できます。取得成功だけで表示済みとは判断せず、画面の読み込み結果を確認してください。",
      "openai/widgetPrefersBorder":true
    }
  };
}
