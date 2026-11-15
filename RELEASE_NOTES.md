# Immich MCP 1.0.0-beta.11

通常のDocker / TrueNAS導入で指定するアプリ環境変数を4項目に整理し、接続設定画面を日本語化・再設計しました。

- 必須の入力は `IMMICH_BASE_URL`、`MCP_PUBLIC_BASE_URL`、`ACCESS_ISSUER`、`ACCESS_AUDIENCE` の4つです。
- 公開鍵URLを認証元から自動設定し、標準の鍵読込先を既定値にします。既存の上書き設定は利用できます。
- APIキー登録を中心にしたカード型の画面に変更し、追加認証・トークン入力・履歴を開閉できます。スマートフォンの表示と操作にも対応します。
- 登録、完了、エラー、追加認証、アップロードの案内を日本語化しました。
- 秘密値の非表示、暗号化保存、署名・AUD・Origin・CSRFの確認、追加認証への明示的な同意を維持します。

データは `/data`、既存の32バイトのマスター鍵は `/run/secrets/vault_master_key` にマウントします。独自パスを使用している既存環境では、その設定を残してください。旧イメージから先に環境変数だけを削除しないでください。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.11`

更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`

[最小構成・既存環境の整理・画面例](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.11/CONFIGURATION.md)
