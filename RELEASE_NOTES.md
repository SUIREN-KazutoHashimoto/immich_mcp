# Immich MCP 1.0.0-beta.12

特定の写真を `asset_id` で指定したとき、一部のChatGPTツール変換で引数が欠ける問題を修正しました。

- 画像取得ツールの入力定義を単純化し、`source`、`asset_id`、サイズ、形式を同じ階層で公開します。
- 個別指定ではID必須、ランダム指定ではID禁止という検証は、上流への通信前に維持します。
- ネイティブ画像、非公開プレビュー、メタデータ除去、暗号化保存、利用者ごとの認証を維持します。
- 呼び出しが完了しても `isError: true` なら成功ではありません。画像ブロックとエラー内容を確認する手順を追記しました。

コンテナ更新後、CloudflareのMCPツール情報を同期し、ChatGPTのプラグイン設定で「ツールを更新」を実行してください。古い定義のままでは `asset_id` が利用できません。データと既存のマスター鍵を維持してください。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.12`

更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`

OCRの変更は含みません。
