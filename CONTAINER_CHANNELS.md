# Docker イメージの更新チャンネル

レジストリ: `ghcr.io/suiren-kazutohashimoto/immich-mcp`。公開済み固定バージョンのイメージと同じダイジェストを、用途別のタグから参照します。

| タグ | 更新対象 |
| --- | --- |
| `stable` | 公開済みの正式 GitHub Release に一致する、最新の安定版 `x.y.z` |
| `beta` | 全件回帰試験とコンテナ確認に合格し、GHCR へ公開された最新の `x.y.z-beta.N` |
| `1.0.0-beta.3` など | 固定バージョン。自動処理は別のソースで上書きしません。 |

正式版が一つもない間は `stable` を作成しません。ベータ版を安定版として公開しないためです。`beta` は正式版と独立したチャンネルなので、正式版の公開で `beta` が安定版へ切り替わることもありません。

## 自動公開の流れ

1. `Publish container to GHCR` は GitHub Release の `published` イベント、または手動実行で起動します。Release からの場合は、タグ `v<package.json の版>` と正式版/プレリリースの区分を照合します。
2. 固定依存関係で `pnpm check` を実行し、Linux amd64 の Docker イメージで起動・readiness・同一ボリュームでの再起動を確認してから、固定バージョンを公開します。既存の固定版は同じソースコミットの場合だけ再利用でき、別コミットによる上書きは拒否します。
3. 成功した公開ワークフローを契機に `Refresh container release channels` が起動し、レジストリの固定版、イメージの版・出典コミット・実行ユーザー、成功した公開履歴を確認します。
4. `stable` は公開済み正式 Release のタグがイメージのコミットに一致することも確認します。対象版を数値として比較し、古い公開処理が後から完了してもチャンネルを古い版へ戻しません。
5. 公開後、チャンネルのダイジェストが確認済みの固定版と一致することを照合します。実行結果は Actions の Summary に残ります。

正式リリースでは、package.json・MCP の版表示・Docker の版ラベルなどを同じ新しい版に更新し、そのソースから `v1.0.0` のようなタグで Release を公開してください。既存版に変更を追加して再利用する場合は、次の版番号を付けます。

## 手動での照合・復旧

GitHub Actions の `Refresh container release channels` を選び、`dry_run=true` で実行すると、候補の検証だけを行います。タグは変更しません。`dry_run=false` では既存の検証済み固定版へチャンネルを合わせます。イメージをビルドし直す操作ではありません。

CI の成功記録を確認できないイメージは新たにチャンネルへ昇格させません。古い記録が保存期間を過ぎた場合は、同じソースから公開ワークフローを再実行して、既存イメージの再確認を行えます。

## 利用側の指定例

~~~text
ghcr.io/suiren-kazutohashimoto/immich-mcp:stable
ghcr.io/suiren-kazutohashimoto/immich-mcp:beta
~~~

今回はレジストリ側のタグ自動公開だけを設定します。TrueNAS や Docker Compose の更新スケジュール・既存コンテナ設定は変更しません。タグ更新は、実行中コンテナの自動置き換えとは別です。

このコンテナ確認は合成の上流応答を使います。実 Immich、Cloudflare、ChatGPT での機能確認を代替しません。

参考: [GitHub の Release / workflow_run イベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)、[コンテナレジストリ HTTP API](https://distribution.github.io/distribution/spec/api/)。
