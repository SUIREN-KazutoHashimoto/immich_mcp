# Immich MCP 1.0.0-beta.9

beta.8の実ChatGPT検証で「画像は表示されるが、初回の呼び出し側にはメタデータしか見えない」ことを確認しました。説明ボタン経由では画像内容を説明できたため、初回の応答形式を変更します。

- `immich_read_image` と `immich_get_image` はネイティブの画像コンテンツを返します。画像ツールからJSONのstructuredContent/outputSchemaを外し、診断メタデータはUI専用の `_meta.image_info` に移します。結果参照は短い通常テキストにも残します。
- 画像ツールの引数、既定の画質、認証、画像バイトの制限は維持します。既存9件の汎用API・ジョブ契約も変更しません。
- beta.8の1回取得・必要なスキーマのみの返却・説明用コンテキスト準備を維持します。
- 画像UIはv4へ更新し、v1〜v3の互換読込先と旧メタデータ形式を残します。

画像ツールの `structuredContent` に依存したbetaクライアントは移行が必要です。MCPの `content` から画像を扱い、UI専用情報は `_meta.image_info` を利用してください。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.9`

更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`

[取得・説明・Code Mode・更新手順](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.9/IMAGE_FLOW.md)

公開前は合成画像でMCPの生応答、SDK、UIを検証します。公開後、同じ実写真でChatGPTの初回説明を比較します。サーバーの送出・UIの表示・モデルの視覚認識は別々の合格条件です。実環境での確認前にホスト固有の欠落が解消したとは断定しません。OCRは変更していません。
