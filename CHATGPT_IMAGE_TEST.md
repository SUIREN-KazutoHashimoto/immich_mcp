# ChatGPT の画像解析連携を確認する

beta.5 は ChatGPT 向け画像経路に表示画面を追加します。対応 Immich は 3.3.5 / 3.3.6 です。公開イメージは `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.7`、更新チャンネルは `:beta` です。

## 修正した境界

beta.4 より前は画像を暗号化保存しても、MCP に返すのは JSON メタデータだけでした。既存9ツールに読み取り専用の `immich_read_image` を追加し、`content` 配列の直下に `type: "image"`、Base64 の `data`、`mimeType` を返します。`structuredContent` は寸法などの小さなメタデータだけです。

`searchAssets`、`viewAsset`、非同期ジョブ、`result_ref`、`immich_read_result` の JSON/テキスト経路は維持しています。匿名公開する画像 URL は作りません。

## beta.7 の表示修正と成功判定

プレビューが開いても「画像を読み込めませんでした」となる報告を受け、表示方式を変更しました。data URLを優先し、必要な場合だけBlob URLに一度切り替えます。どちらも認証済みの応答内の画像だけを使います。外部通信、公開URL、画像の永続化は追加しません。

旧版に「data画像は許可するがBlobは許可しない」という制約を適用すると、二重の隔離フレーム内で報告と同じエラーを再現できました。この再現は旧実装のBlob依存を示しますが、添付の実機ブラウザーのポリシーを直接確認した証拠ではありません。

新しい画面のURIは `ui://immich/image-preview/v2.html` です。古いv1のURIも読めますが、ホストにキャッシュされた旧HTMLまでは置き換えられません。コンテナ・Cloudflare・ChatGPTの定義を更新し、ChatGPTの画面も再読み込みして新しい会話で確認してください。

画像取得のHTTP200、MIME、寸法だけでは表示成功になりません。

| 段階 | 判定 |
| --- | --- |
| `immich_read_image` の正常応答 | 画像を準備しただけ。`structuredContent.display_status` は `unconfirmed` |
| 画面内で画像がデコードされ、表示された | MCP Apps のモデルコンテキストに `display_status: displayed` を報告 |
| 画像がない、破損している、表示制約等で読み込めない | `display_status: failed` を報告し、画像・保存リンクを消して説明ボタンを無効化 |
| モデルが画像の内容を説明できる | 上記と別の確認項目。実際の物体・色・配置で検証 |

状態報告は元の読み取りの `request_id` に対応します。写真やBase64、元の結果参照を状態メッセージには含めません。状態報告だけで新たなユーザーメッセージを自動送信しません。ホストがコンテキスト更新を受け付けない場合、モデルへの状態報告は成立しないため、画面の表示を優先して確認します。

画面内プレビューはChatGPTのネイティブなファイル添付とは別です。データの準備、画面表示、モデル認識、ファイル添付を同じ成功として説明しないでください。

## beta.5 の表示と説明

`immich_read_image` に MCP Apps の表示リソースを関連付けました。対応ホストでは画像プレビュー、「この画像を説明」、「画像を保存」を表示します。保存対象は縮小・メタデータ除去済みの画像です。

トップレベルの ImageContent と同じ画像を、画面専用の `_meta.image_content` にも渡します。後者はモデルには公開されません。画面内ではdata URLを優先し、必要な場合だけ一時的なBlob URLへ切り替え、外部への通信や匿名公開は行いません。説明ボタンは実画像をモデルのコンテキストに渡して説明を依頼します。非対応ホストには画像付きメッセージを試み、拒否された場合は失敗を表示します。

**チャット内の表示と、モデルによる画像認識は別の合格条件です。** 報告には MCP 生応答がなく、どの層で画像が失われたかは断定していません。

## 更新後の操作

1. TrueNAS の Custom App を更新します。`:beta` は常に取得する設定を確認し、取り違えが疑われる場合は固定版 `:1.0.0-beta.7` を指定します。データとマスター鍵を維持してください。
2. Cloudflare で MCP サーバーの能力を再同期し、ポータルの画像ツールが有効か確認します。表示用リソースの要求も通る必要があります。
3. ChatGPT の SUIREN MCP 管理画面でツール定義を更新し、**新しい会話**で接続を選び直します。サーバー情報ツールを含め11ツールです。UIを含む新しい定義が必要です。
4. 新しい画像結果を取得し、画面表示と「この画像を説明」での物体・色・配置の説明を個別に確認します。

## Docker で修正版を使う

公開イメージを取得するか、このソースのルートでローカルビルドできます。

~~~sh
docker pull ghcr.io/suiren-kazutohashimoto/immich-mcp:beta
~~~

~~~sh
docker build -t immich-mcp:chatgpt-image-fix .
~~~

既存コンテナのイメージを `immich-mcp:chatgpt-image-fix` に変更して再作成します。同じマスター鍵、データボリューム、利用者ごとのキー、Access 設定を使います。Compose の準備は [BETA_DOCKER_TEST.md](BETA_DOCKER_TEST.md) を参照してください。

`compose.beta.yaml` の場合は、既存の非公開 beta.env の `MCP_IMAGE` を新しいタグに変更し、既存のプロジェクト名と環境ファイルで `up -d` を実行します。以下の絶対パスは実際の設定場所に置き換えてください。

~~~sh
docker compose --env-file /absolute/private/beta.env -f compose.beta.yaml config --quiet
docker compose --env-file /absolute/private/beta.env -f compose.beta.yaml up -d
~~~

Windows/Node.js 24 の画像変換と MCP 通信を検証しています。公開パイプラインでも Linux Docker の起動・再起動と製品イメージ内の画像コンテンツ変換を確認してから公開します。実 Immich、Cloudflare、ChatGPT での画像認識は、導入後の接続先環境で確認してください。

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

## 中継・Code Mode の診断

Code Mode で呼び出す場合、`structuredContent` の寸法だけを出力してもモデルには画像が届きません。`image(block)` が提供される環境では、返った画像パートを次のように転送します。実際のツール名は中継の接頭辞に合わせてください。

~~~js
const result = await tools.immich_read_image({result_ref: completedResultRef});
for (const block of result.content ?? []) {
  if (block.type === "image") image(block);
}
~~~

通常のツール呼び出しでホストが自動処理する場合は不要です。Base64 やツール結果全体をテキスト出力・ログに記録しないでください。

管理者が取得済みの生応答を非公開ファイルで調べる場合:

~~~sh
pnpm build
node dist/scripts/image-result-check.js /absolute/private/mcp-response.json
~~~

直接応答または JSON-RPC の `result` にある ImageContent をデコードし、画像数・寸法・MIME・バイト数・SHA-256 のみを出します。寸法だけの応答や UI 専用画像だけでは `ok: false` になります。写真、Base64、利用者、参照値を検査結果には出しません。生応答自体は非公開で扱ってください。Docker にも同じ検査スクリプトを含みます。

サーバー直後と中継後で画像数・ハッシュを比較すると、失われた境界を絞れます。両方に画像があっても呼び出し側で転送しなければモデルの視認は成立しません。

## 検証と公式資料

実 HTTP と公式 SDK で画像と表示リソースの取得、実ブラウザーでプレビュー描画・説明操作・代替経路・古い画像の消去を検証します。所有権・期限・認証変更・画像制限の回帰試験に加え、公開パイプラインでは全件試験と実 Linux Docker の画像変換・表示画面読込を確認します。

合成画像と模擬ホストによる検証は、実 ChatGPT の視認成功を証明しません。導入後の画像表示と画像認識を別々に確認してください。OCR の `projection_mismatch` は今回の対象外です。

- [OpenAI: Tool results](https://developers.openai.com/plugins/reference#tool-results)
- [OpenAI: ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI: Refresh metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)
- [Cloudflare: MCP portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [MCP Apps: messages](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiMessageRequest.html)
