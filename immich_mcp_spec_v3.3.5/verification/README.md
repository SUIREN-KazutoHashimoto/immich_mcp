# この仕様パッケージの検証記録

検証対象は、公式資料から作成した仕様・台帳・補正契約の整合性です。MCPアプリケーションの実装や稼働中サーバーへの試験は対象ではありません。

## 確認したこと

- 固定OpenAPI原本のバージョン、commit、サイズ、SHA-256、Git blob SHA。
- 全279操作のoperationId・method・pathと台帳の完全一致。
- 原本内の743箇所のschema参照の解決。
- 全41主タグの件数と、仕様書の集計表の一致。
- 認証例外のoperationIdと分類件数。
- 52操作の既知補正、40個の秘密schema-field、75個の具体的なbindingの参照整合性。
- 9個のMCPツール契約のJSON構文、ローカルschema参照、required field、fileParamsの定義。
- 仕様書の22章の連続性、コードフェンス、図の基本構造。
- 通常キーの自動fallback禁止と、汎用session追加モードの既定無効が契約に残っていること。

JSON Schemaについては構造と参照を検証しました。完全なmetaschema validatorによる検証や、MCPクライアントへの登録試験まで実施したとはしていません。

## 仕様レビューで反映した点

全API台帳、利用者認証、通信・結果処理の三つの観点で本文を照合しました。メタデータ検索の正式operationIdをsearchAssetsに修正し、OAuth callback入力、キー更新後のsession所有者再照合、public/setupのキー未登録時の到達性、CSRF/Origin、受付ack喪失時のjob回復を明確にしました。

## 機械可読の結果

- `inventory-verification.json`: 原本と台帳の完全性。
- `package-verification.json`: 仕様パッケージ全体の整合性。

再実行はパッケージrootで次のとおりです。

```bash
python3 api/verify_openapi_inventory.py
python3 verification/verify_package.py
sha256sum -c SHA256SUMS
```

将来の実装の合否は、詳細仕様第18〜20章に定義したwire全件試験、隔離Immich統合試験、Cloudflare/ChatGPT接続試験で別途判断します。
