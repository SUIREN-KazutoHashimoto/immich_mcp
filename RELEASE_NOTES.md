# Immich MCP 1.0.0-beta.7

画像取得がHTTP200でも、チャットの画面が「画像を読み込めませんでした」となる報告への修正です。Blob URLを必須としていた表示を、画像データの直接表示へ変更しました。

- 制約のある二重フレームでも表示できるよう、data URLを優先します。Blob URLだけを許可するホストには一度だけ切り替えます。外部通信・公開画像URLは追加しません。
- サーバー応答は `display_status: unconfirmed` を返します。画面が画像を実際に読み込んだ後に `displayed`、失敗時に `failed` をモデルへ伝えます。HTTP200や画像メタデータだけを根拠に表示済みと判断しないよう定義を更新しました。
- 表示リソースを `ui://immich/image-preview/v2.html` に更新して旧HTMLのキャッシュと区別します。旧v1の読込先も互換性のため残します。
- 全読み込み方式が失敗した場合は画像を消して説明ボタンを無効にし、古い画像を残しません。状態報告だけでユーザーメッセージを自動送信することもありません。

固定版: `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.7`

更新チャンネル: `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta`

データとマスター鍵を維持してコンテナを更新し、Cloudflareの能力同期・ChatGPTのツール定義更新と画面の再読み込みを行います。新しい会話で画像プレビューを試してください。

[画像表示・判定・更新の手順](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.7/CHATGPT_IMAGE_TEST.md)

旧版では、data画像だけを許可する制約下で同じエラーを再現できました。修正版はモバイル幅・二重の隔離フレームで、dataのみ許可、Blobのみ許可、一時URL機能なし、両方式禁止時の正しい失敗処理を検証します。公開パイプラインでは全件回帰と実Linux Dockerの検証も行います。

添付された実機のCSPやブラウザー内部のエラーは取得できていないため、実機で同じ制約が原因だったとまでは断定していません。Android/iOS実機での最終確認は反映後に必要です。OCRは変更していません。
