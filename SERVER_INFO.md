# ChatGPT から MCP サーバー情報を確認する

beta.6 で読み取り専用の `immich_get_server_info` を追加しました。Immich API の `getServerVersion` や `immich_get_connection.target_version` とは区別して、実際に応答している MCP 本体の情報を返します。

## 使い方

更新・接続定義の再取得後、新しい ChatGPT の会話で次のように依頼します。

> Immich MCP サーバーの情報を取得して。MCP本体のバージョン、ビルド番号、稼働時間、健全性、接続先Immichのバージョンを教えて。

ツールの引数は空のオブジェクトです。ポータル経由ではツール名に接頭辞が付く場合があります。

~~~json
{}
~~~

## 返る情報

| 項目 | 意味 |
| --- | --- |
| `server.version` | MCPアプリのバージョン。今回の公開版は `1.0.0-beta.6` |
| `server.build_revision` | 公開コンテナのソースコミット。ビルド時に指定がないローカル版は `null` |
| `server.started_at` / `uptime_seconds` | 稼働インスタンスの開始日時と経過秒数。呼び出しごとにはリセットしない |
| `readiness.ready` | 上流とローカルの検査を合わせた利用準備状態 |
| `readiness.local_checks` | DB・移行・マスター鍵・保存領域・固定定義の検査結果 |
| `readiness.storage_cleanup` | 保存データの清掃処理の状態 |
| `immich.api_contract_version` | 固定API定義の `3.3.5`。MCP本体のバージョンではない |
| `immich.supported_versions` | 対応するImmichのバージョン |
| `immich.observed_version` | 直近の検査で確認できたImmichのバージョン。失敗時・不正な値は `null` |
| `immich.state` / `checked_at` | 上流の検査結果とその検査日時 |
| `capabilities` | このサーバーに登録された11ツールと、画像読み取り・表示リソースの対応 |

健全性は既存の定期検査の結果です。このツールは上流通信や新たなディスク検査を起こしません。`checked_at` を見て検査時刻を確認してください。ローカル検査にも `local_checks.checked_at` があります。画像表示への対応はサーバー側の能力であり、ChatGPTや中継側で表示できた証拠ではありません。

MCPの本人認証は必須です。Immichの個人APIキー登録前でも照会でき、上流の接続不良・バージョン不一致・ローカル検査失敗時も診断に使えます。APIキー、認証トークン、写真、利用者識別子、他利用者の情報、内部URLやファイルパスは返しません。

## 更新後の操作

1. TrueNAS等で `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta` を取得し直してコンテナを更新します。固定版は `:1.0.0-beta.6` です。既存データとマスター鍵を維持してください。
2. CloudflareでMCPサーバーの能力を同期し、ポータルで新しい `immich_get_server_info` が有効か確認します。
3. ChatGPTでSUIREN MCPのツール定義を更新し、新しい会話で接続を選び直します。
4. 本ツールの `server.version` と `build_revision` が公開版に一致するか確認します。

サーバー情報ツール自体が見つからない場合、稼働コンテナまたは中継・ChatGPTの定義が古い可能性があります。取得できない状態から、インストール済みのバージョンを推測しないでください。`immich_get_connection.target_version` が `3.3.5` であることだけでは更新確認にはなりません。
