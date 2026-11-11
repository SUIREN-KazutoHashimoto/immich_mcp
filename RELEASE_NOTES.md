# Immich MCP 1.0.0-beta.4

ChatGPT 向けの画像読み取り経路を公開します。JPEG の取得が成功しても JSON メタデータしか返らなかった経路に、読み取り専用ツール `immich_read_image` を追加しました。既存9ツールと合わせて10ツールになります。

## 画像を ChatGPT に渡す

1. `viewAsset` を実行し、非同期の場合は `immich_get_job` で完了を確認します。
2. 完了結果の `result_ref` を `immich_read_image` に渡します。
3. ツールは MCP のトップレベル `content` に画像を返します。`immich_read_result(mode="preview")` は従来どおり JSON メタデータ用です。

所有者・有効期限・キー更新・認証コンテキストを確認し、JPEG/PNG/単一フレームWebPを縮小・再エンコードして返します。EXIF/GPS等のメタデータを除去し、入力・画素数・出力サイズ・同時実行・変換時間を制限します。暗号化された原本は変更せず、無認証の公開URLも作りません。

## 更新

- イメージ: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.4`
- 更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`
- 配布対象: Linux amd64
- 対応 Immich: 3.3.5 / 3.3.6

既存のデータとマスター鍵を維持してコンテナを更新してください。**ChatGPT と中継ポータルのツール定義も更新し、`immich_read_image` が一覧にあることを確認してください。**

[画像経路の手順・制限・診断](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.4/CHATGPT_IMAGE_TEST.md) / [更新チャンネル](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.4/CONTAINER_CHANNELS.md)

## 検証と今回の範囲

画像経路と認証境界のローカル関連50試験は合格済みです。公開パイプラインでは全件回帰試験、実Dockerの非root・読み取り専用起動と再起動、製品イメージ内の画像コンテンツ変換を確認してからイメージを公開します。実行結果は GitHub Actions の公開記録を参照してください。

これらは合成データによる検証です。実際の ChatGPT 接続で画像内容を説明できることの確認は、導入・ツール定義更新後に行います。**今回 OCR の `projection_mismatch` は修正していません。**
