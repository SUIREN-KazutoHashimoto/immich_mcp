# Immich MCP 1.0.0-beta.6

ChatGPTから実際に稼働しているMCP本体の情報を取得できる、読み取り専用の `immich_get_server_info` を追加しました。

- MCP本体のバージョン、ビルド元コミット、開始日時・稼働時間を返します。
- キャッシュされた健全性、対応・確認済みImmichバージョン、利用可能な11ツールを返します。
- ImmichのAPIキー未登録時や、上流・ローカル検査の失敗時も照会できます。MCP本人認証は必須です。
- APIキー、認証トークン、写真、利用者情報、内部URLや保存場所は返しません。
- MCP本体のバージョンと、固定API定義 `3.3.5` を明確に区別します。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.6`
更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`
Linux amd64 / Immich 3.3.5・3.3.6対応

コンテナ更新後、Cloudflareの能力同期とChatGPTのツール定義更新を行い、新しい会話で「Immich MCPサーバーの情報を取得して」と依頼してください。

[サーバー情報の項目・確認手順](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.6/SERVER_INFO.md)

MCP通信の認証境界、キー未登録・障害時の取得、秘密情報の除外とバージョンの整合を検証します。公開パイプラインは全件回帰試験と実Linux Dockerでのサーバー情報取得・ビルド元照合・起動・再起動・画像処理を確認してから公開します。実ChatGPTでの確認は導入・定義更新後に行います。OCRは今回も変更していません。
