# beta.8: 1枚の取得・表示・説明

通常は `immich_get_image` を使います。既定の最大1600×1600、JPEG品質80、最大1 MiB、メタデータ除去は従来と同じです。

~~~json
{"source":"random"}
~~~

画像IDが分かる場合:

~~~json
{"source":"asset","asset_id":"<閲覧可能な画像のUUID>","max_width":1600,"max_height":1600,"format":"jpeg"}
~~~

検索・取得・画像変換はサーバー内部で実行し、モデル向け `content` の画像ブロックと画面プレビューを返します。ID指定は上流1回、ランダム選択は上流2回ですが、ChatGPTからは通常1回のツール呼び出しで済みます。取得期限は30秒で、自動再試行や別認証への切替はしません。

完了済みの `result_ref` がある場合は、再取得せず `immich_read_image` を使います。最初の応答には説明に必要な画像が含まれます。説明のためだけに検索・取得をやり直さないでください。

## Code Modeで画像がない場合

追加報告は、呼び出し側に寸法などのオブジェクトだけが見える症状です。サーバーの生成失敗と断定せず、同じ参照・同じ変換条件で、MCP直結、中継、ChatGPT通常呼び出し、Code Modeを比較します。版・ビルド番号は `immich_get_server_info` で記録します。

完全なMCP応答なら、画像ブロックを `image(block)` で転送します。`structuredContent` だけを取り出すと画像本体は失われます。

~~~javascript
const response = await tools.immich_read_image({result_ref: completedResultRef});
let result = response;
for (let depth = 0; depth < 5 && result && !Array.isArray(result.content); depth++) {
  result = result.mcp_tool_result ?? result.call_tool_result ?? result.result;
}
const pixels = result?.content?.filter(block => block.type === "image") ?? [];
if (!pixels.length) {
  text({code: "image_content_missing", message: "受信値に画像本体がありません。内容を推測しないでください。"});
} else {
  for (const block of pixels) image(block);
}
~~~

ツール名は接続先の接頭辞に合わせます。メタデータだけの値から画像は復元できません。同じ画像の再試行やJSON取得を繰り返さず、プレビューの「この画像を説明」を使うか、確認できない段階を報告してください。

プレビューは描画後に同じ画像をモデルのコンテキストへ準備します。成功済みなら説明ボタンで画像を再送せず、失敗時は従来の画像付きメッセージへ切り替えます。ユーザー操作なしに説明メッセージは送りません。画像が切り替わった場合は古い準備状態を破棄します。

## 成功を混同しない

| 段階 | 確認できる証拠 |
| --- | --- |
| 上流取得 | 完全なHTTP200画像応答 |
| MCP送出 | 生応答の画像ブロックとデコード可能な画素 |
| モデル入力 | 呼び出し側の画像転送、または画像コンテキストの受付。受付だけで認識成功とはしない |
| UI表示 | 画像の描画後に画面が `displayed` を報告 |
| 視覚解析 | ファイル名や日時から推測できない物体・色・配置の説明が正しい |

サーバーの `display_status` は常に `unconfirmed` です。画像診断スクリプトも、モデル入力・UI表示・内容説明を勝手に成功にせず `unknown` とします。`content_type: image` やUI専用の `_meta` だけではモデル向け画像の証拠になりません。

## 計測

`reports/image-flow-benchmark-beta.8.json` は同じ3種類の合成画像を使った各30回の比較です。旧版の通常ジョブ経路、旧版の同期取得経路、新しい1回取得を測ります。実HTTP/MCPですが上流は模擬環境です。ジョブ未完了時の再確認間隔は100msです。Cloudflare、ChatGPT推論、スマートフォンの体感時間は含みません。全経路で出力画像バイトの一致を確認します。

beta.7のソースを別ディレクトリでビルド後、再実行できます。

~~~sh
pnpm exec tsx tests/image-flow-benchmark.ts /absolute/path/to/beta.7/dist
~~~

`image_fetch` ログには検索・取得・画像処理・全体のミリ秒と、画像処理に対応する `image_request_id` を記録します。`image_read` には認可・読み取り・デコード・エンコードの内訳があります。写真・Base64・キー・利用者・元の参照値は記録しません。画面内の `immich-preview-draw` と `immich-explain-dispatch` はローカルのPerformance測定で、外部送信しません。

生応答は次の既存診断で検査できます。実写真の応答は非公開で扱ってください。

~~~sh
node dist/scripts/image-result-check.js /absolute/private/mcp-response.json
~~~

## 更新後の受け入れ

コンテナ更新後、Cloudflareで能力を同期し、ChatGPTでツール定義更新・再読み込みを行います。Immich側は12ツール、中継を含むSUIREN MCPは15ツールです。画像UIはv3へ更新し、v1・v2も読めます。

新しい会話で、既知の写真を「表示」「表示して説明」「説明ボタン」で確認します。JPEG/WebP、700/1600/2048の指定、異なる3枚を1枚ずつ確認します。生MCP応答が正しくても、別のChatGPT Code Modeで同じ受信構造になる保証にはなりません。管理できない層での欠落は残る制約として記録し、表示だけで解析修正完了とはしません。

OCR、複数枚一括取得の新機能、画質低下、画像キャッシュ、同時処理数増加、認証・Cloudflare構成変更は対象外です。
