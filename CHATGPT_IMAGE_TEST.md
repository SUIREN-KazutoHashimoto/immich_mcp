# ChatGPT の画像解析連携を確認する

この開発ソースには、beta.3 を基にした未リリースの画像連携修正が含まれます。公開済み beta.3 イメージにはまだ含まれません。対応 Immich は 3.3.5 / 3.3.6 です。

## 修正した境界

従来は画像を暗号化保存しても、MCP に返すのは JSON メタデータだけでした。既存9ツールに読み取り専用の `immich_read_image` を追加し、`content` 配列の直下に `type: "image"`、Base64 の `data`、`mimeType` を返します。`structuredContent` は寸法などの小さなメタデータだけです。

`searchAssets`、`viewAsset`、非同期ジョブ、`result_ref`、`immich_read_result` の JSON/テキスト経路は維持しています。匿名公開する画像 URL は作りません。

## Docker で修正版を使う

このソースのルートで新しいローカルタグを使ってビルドします。

~~~sh
docker build -t immich-mcp:chatgpt-image-fix .
~~~

既存コンテナのイメージを `immich-mcp:chatgpt-image-fix` に変更して再作成します。同じマスター鍵、データボリューム、利用者ごとのキー、Access 設定を使います。Compose の準備は [BETA_DOCKER_TEST.md](BETA_DOCKER_TEST.md) を参照してください。

`compose.beta.yaml` の場合は、既存の非公開 beta.env の `MCP_IMAGE` を新しいタグに変更し、既存のプロジェクト名と環境ファイルで `up -d` を実行します。以下の絶対パスは実際の設定場所に置き換えてください。

~~~sh
docker compose --env-file /absolute/private/beta.env -f compose.beta.yaml config --quiet
docker compose --env-file /absolute/private/beta.env -f compose.beta.yaml up -d
~~~

この修正は Windows/Node.js 24 で画像変換と MCP 通信を検証しています。修正後の Linux Docker 起動、実 Immich、Cloudflare、ChatGPT での最終確認は別途必要です。過去の Docker 検証を今回の検証として読み替えないでください。

## ChatGPT での呼び出し順

1. ChatGPT の接続設定で MCP のツール定義を更新し、`immich_read_image` が利用可能か確認します。サーバー再起動だけでキャッシュされた定義が更新されるとは限りません。
2. 対象の Immich MCP 接続を選択します。
3. `searchAssets` で対象を検索し、静止画の ID を `viewAsset` に渡します。最初は `size: "preview"` を使います。
4. `job_ref` が返った場合、`immich_get_job` で `completed` を確認し、その結果の `result_ref` を使います。
5. `immich_read_image` を呼びます。`immich_read_result(mode="preview")` はメタデータ確認用です。

~~~json
{"result_ref":"<completed job の result_ref>","max_width":1600,"max_height":1600,"format":"jpeg"}
~~~

確認用プロンプト例:

> Immich MCP で指定日の静止画を1枚取得し、ジョブ完了後の result_ref で immich_read_image を呼んでください。画像を実際に見て物体と色を説明してください。画像を受け取れなかった場合は、メタデータから推測せず、その段階を報告してください。

内容の分かる非機密のテスト写真で、ファイル名や EXIF だけでは答えられない物体・色・配置を確認します。単一画像で成功した後、複数枚を1枚ずつ読み、順序を保って要約できるか確認します。動画本体や指定時刻のフレーム抽出は今回の対象に含みません。

## 制限と参照の寿命

- 入力は JPEG / PNG / 単一フレーム WebP。MIME・シグネチャ・デコーダーの形式を照合します。SVG、GIF、アニメーションは返しません。
- 転送時・展開後とも32 MiB、40メガピクセル、最大4チャンネル。出力枠は既定1600×1600、最大2048×2048。縦横比を保ち、小さい画像は拡大しません。
- 出力は JPEG（既定）/ WebP、最大1 MiB。超えた場合は最大1024×1024・低い品質で再変換し、それでも超えた画像は返しません。各変換5秒・最大2回です。I/O を含む処理全体のタイムアウトではありません。
- 同時読み取りは2件。枠が埋まると `image_busy` を返し、無制限にキューへ積みません。
- EXIF の向きを画素へ反映し、EXIF / GPS / XMP / IPTC / ICC を除去します。透過部分は白背景にします。元画像は変更しません。
- 変換画像は永続化せず、認証された MCP 応答だけに載せます。復号済み一時ファイルは作りません。原本と参照は既存の結果 TTL（既定1時間）に従い、画像読み取りで延長しません。
- 所有者・期限・キーのリビジョン・コンテキストを、読み取り前と返却前に検証します。取得時に上流が許可した結果を使います。Immich 側だけで行われた権限変更は即時に知る仕組みがないため、最新の上流権限を確認する場合は新しく `viewAsset` を実行します。

## エラーと調査ログ

| コード | 内容 |
| --- | --- |
| `invalid_reference` | 不存在・他利用者の参照・不正な参照形式。他利用者の参照の存在は開示しません。 |
| `image_reference_expired` | 自分の結果参照の期限切れ。 |
| `image_reference_forbidden` | キー更新・切断、コンテキスト失効・世代変更。 |
| `image_result_incomplete` | 取得失敗、部分応答、転送中断。 |
| `image_unsupported_mime` / `image_mime_mismatch` | 非対応形式、アニメーション、MIME 不一致。 |
| `image_decode_failed` | 破損データ、復号・転送デコードの失敗。 |
| `image_size_exceeded` | バイト数・画素数・出力サイズ超過。 |
| `image_conversion_timeout` / `image_conversion_failed` | 変換の失敗。 |
| `image_busy` / `image_cancelled` | 同時実行上限、キャンセル。 |
| `invalid_image_options` | 不正な寸法・出力形式。MCP 入力スキーマでも検証します。 |

JSON ログの `event: "image_read"` と `request_id` を応答と照合できます。参照のハッシュ、段階、許可された MIME、入出力サイズ、コードとコンテンツ種別だけを記録し、画像、Base64、API キー、利用者識別子、GPS、元の `result_ref` は記録しません。

`stage: "return"` / `code: "ok"` / `content_type: "image"` はサーバーが画像パートを作成した証拠です。ChatGPT が受信・視認した証拠ではありません。上流の画像取得 → MCP 生応答の画像パートとデコード → ChatGPT の定義更新 → 実際の内容説明の順に確認します。共有するログは該当の request_id・コード・段階だけで十分です。

## ローカル検証と公式資料

`tests/image-content.test.ts` は非同期取得から MCP 生応答と公式 SDK の画像受信まで、`tests/images.test.ts` は変換・所有権・期限・認証変更・圧縮爆弾・上限・ログを検証します。ChatGPT で画像内容を説明する確認は、接続先環境で別途行います。

- [OpenAI: Tool results](https://developers.openai.com/plugins/reference#tool-results): モデルに公開される結果フィールド。
- [OpenAI: MCP server quickstart](https://developers.openai.com/plugins/build/app-quickstart): 変更後の接続定義の更新。
- [sharp の出力仕様](https://sharp.pixelplumbing.com/api-output/): メタデータ除去と変換時間の制限。

検証結果（2026-11-11）: 新規12件を含む関連50件が全件合格しました。生成・ビルド・仕様原本の照合と、本番依存関係だけでのネイティブ画像処理も合格しています。[検証記録](reports/image-content-verification-2026-11-11.json) を参照してください。全件回帰試験と実機での画像認識を示す記録ではありません。

接続済みポータルの状態照会では active を確認しましたが、新しい画像ツールは現在の一覧にありません。これは状態とツール一覧だけの確認で、写真データは参照していません。サーバーにこの修正を導入し、ポータル側を含む定義を更新してから画像認識を確認してください。
