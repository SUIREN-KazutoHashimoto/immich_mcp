# Immich MCP 1.0.0-beta.5

画像を取得できてもチャットに表示されず、モデルがメタデータだけを扱う報告への修正です。`immich_read_image` に画像プレビューと「この画像を説明」操作を追加します。

- MCP ImageContent に加え、同じ認証済みプレビューを画面専用メタデータにも渡します。公開画像 URL は作りません。
- 画面で表示・保存でき、ボタン操作で実画像をモデルのコンテキストまたはユーザーメッセージへ渡します。
- Code Mode の画像転送方法と、生応答を調べる機密情報を含まない診断出力を追加しました。中継側の障害と断定していません。

## 更新

- 固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.5`
- チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`
- Linux amd64 / Immich 3.3.5・3.3.6 対応

データとマスター鍵を維持してコンテナを更新し、Cloudflare の能力再同期、ChatGPT のツール定義更新を行ってください。**新しい会話**で画像表示と画像内容の説明をそれぞれ確認します。ツール数は10のままです。

[更新・画像連携の手順](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.5/CHATGPT_IMAGE_TEST.md) / [更新チャンネル](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.5/CONTAINER_CHANNELS.md)

## 検証の範囲

実ブラウザーの画像描画・明示的な画像転送、MCP 通信の画像・リソース取得、権限とメタデータ除去を検証しています。公開パイプラインで全件回帰試験と実 Linux Docker の非root・読み取り専用起動、再起動、画像変換、表示画面読込を確認してから公開します。

合成データと模擬ホストの試験は、実 ChatGPT の視認成功を証明しません。導入後の画像表示と画像認識は別々の確認項目です。**OCR の `projection_mismatch` は今回修正していません。**
