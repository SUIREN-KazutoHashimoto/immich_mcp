# Immich MCP 1.0.0-beta.10

Immichの既存279操作を最新版3.4.1に対応させ、未検証のバージョンでも注意を返しながら利用できるようにしました。

- 対応一覧: Immich 3.3.5 / 3.3.6 / 3.4.0 / 3.4.1。
- 公式3.4.1のAPI定義を固定コミットとハッシュで検査し、追加の設定・機能・featureLevelや列挙値を反映します。旧版の応答も維持します。
- API権限4件の変更は、API説明に版ごとの情報として記録します。
- 未検証版でもAPIキー登録・同期処理・ジョブ・画像取得を停止しません。通常の結果では `compatibility_warnings` とテキスト、画像とエラーではテキストに注意を添えます。
- バージョン相違による準備未完了を解消します。上流への到達失敗、ローカル保存領域・鍵の異常、認証・権限エラーは従来どおり扱います。
- 旧設定 `IMMICH_EXPECTED_VERSION` による起動拒否を廃止します。

新しいパスキー関連8操作とJXLプレビューは対象外です。OCRとbeta.9の画像経路は変更していません。実Immichで全操作を検証したという主張ではありません。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.10`

更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`

[対応範囲・注意の形式・更新手順](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.10/IMMICH_COMPATIBILITY.md)
