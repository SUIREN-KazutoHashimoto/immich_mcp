# Immichの対応バージョンと未検証版の扱い

beta.10では、既存279操作を対象に **Immich 3.3.5 / 3.3.6 / 3.4.0 / 3.4.1** を扱います。2026年11月16日時点の最新版は3.4.1です。[公式リリース](https://github.com/immich-app/immich/releases/tag/v3.4.1) と [比較記録](reports/immich-3.4.1-compatibility.json) を参照してください。

元の3.3.5のAPI原本と補正は保持し、3.4.1の公式OpenAPIを固定コミットとSHA-256で追加検査します。既存279操作のメソッド・パス・送受信定義は維持されています。増えた設定・機能・featureLevel、列挙値を反映し、旧版のtheme項目も扱えるようにしました。変更された権限4件はAPI説明の `auth_requirements.version_overrides` に版ごとの情報を載せます。認証と権限の判定は引き続きImmich側が行います。

3.4.0と3.4.1のOpenAPIは `info.version` 以外が一致しています。これはAPI定義と合成環境での確認です。実際の3.4.1サーバーで全操作を実行したという意味ではありません。

## 未検証版でも利用を続ける

対応一覧にない正式版・プレリリースでも、バージョン相違だけでは停止しません。APIキーの接続、同期呼び出し、ジョブ、画像取得を継続し、ChatGPTに返す結果へ注意を添えます。

通常の結果では `structuredContent.compatibility_warnings` とテキストに、画像ではネイティブ画像を保ったままテキストに注意を入れます。実行中に版の検査結果が変化しても、開始時にあった注意はその応答に残します。ジョブ結果、結果の読み取り、サーバー情報、処理エラーにも同じ方針を適用します。

~~~json
{
  "code": "unverified_immich_version",
  "observed_version": "4.0.0",
  "reviewed_versions": ["3.3.5", "3.3.6", "3.4.0", "3.4.1"],
  "api_contract_version": "3.3.5",
  "message": "This Immich version has not been verified with this MCP server. Requests are allowed, but some API operations or response fields may be incompatible. Tell the user this limitation; do not claim the request failed or retry solely because of this warning."
}
~~~

ChatGPTは「このImmichバージョンは未検証のため、一部機能が正常に動作しない可能性があります」と利用者に伝え、実際の処理結果と区別してください。注意だけでエラー扱いや自動再試行をしません。HTTP403等の本当の失敗、未確定の結果は引き続きそのまま返します。

`immich_get_server_info` の `immich.state: "version_mismatch"` は、beta.10以降は「未検証版」の注意です。到達可能でローカル検査が正常なら `readiness.ready` はtrueです。非対応版の動作保証を示す値ではありません。

旧設定 `IMMICH_EXPECTED_VERSION` は起動を妨げない互換用の設定として無視します。接続先が返したバージョンを基準に注意を生成します。

## 維持する制限

上流に到達できない、版の応答を読み取れない、保存領域や鍵の検査に失敗する場合の保護は維持します。認証の省略、別の認証への切替、未知の返却項目や秘密値の無条件な公開は行いません。未知のAPI変更により、一部の操作や返却項目が利用できない場合があります。

今回の対象は既存279操作の互換対応です。3.4で増えたパスキーの登録・認証・管理8操作は追加していません。画像の表示用デコーダーはJPEG・PNG・WebPのままで、JXLプレビューは対象外です。OCRの追加修正は含みません。

## 更新と確認

1. TrueNAS等で `ghcr.io/suiren-kazutohashimoto/immich-mcp:beta` を再取得して更新します。固定版は `1.0.0-beta.11` です。
2. CloudflareでImmich MCPの能力を同期します。ツール数は12件のままです。
3. ChatGPTの接続設定でツール定義を更新し、新しい会話を開きます。共通ポータルの3件を含めると15件です。
4. `immich_get_server_info` でMCP版beta.10、接続先の版、準備状態を確認します。
5. 3.4.1ではバージョン注意なしで通常の読み取りと画像表示を確認します。未検証版では処理結果と注意の両方が返ることを確認します。書き込みや認証操作を、検証のためだけに本番データへ行わないでください。
