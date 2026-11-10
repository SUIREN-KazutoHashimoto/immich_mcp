# Immich MCP 1.0.0-beta.2

公式OpenAPIとサーバー実装の比較に基づき、安定版Immich 3.3.6を許可します。3.3.5と3.3.6のOpenAPIは`info.version`以外が完全一致し、全279操作・スキーマとサーバーAPI実装に変更はありません。API定義は3.3.5の原本を維持し、未確認のバージョンとプレリリースは拒否します。

- [上流の公式差分](https://github.com/immich-app/immich/compare/v3.3.5...v3.3.6)
- [コミット・APIハッシュと比較記録](reports/immich-3.3.6-compatibility.json)

認証、利用者ごとのAPIキー、暗号化保存、データ形式、マスターキーの扱いは共通です。更新時は`/data`と既存のマスターキーを維持してください。

GUI用イメージは`ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.2`です。手動公開ワークフローはLinux上の全回帰試験と実コンテナの起動・再起動確認が成功した場合だけ公開します。

ローカルWindowsでは生成・ビルドおよび710/714試験が成功しました。残る4件は既存のバックアップ保持・削除試験でSQLiteのファイルオープンに失敗しており、互換性追加試験はすべて成功しています。Linuxでの結果は公開ワークフローの実行記録を参照してください。API比較では本番の写真変更操作を実行していません。

## 初回ベータ1.0.0-beta.1の履歴

1.0.0に向けた最初のベータです。対応するImmich APIは3.3.5です。

- 公式279操作・9つのMCPツール
- 利用者ごとのAPIキー、明示的な追加認証、暗号化保存
- 永続ジョブと未確定処理の再実行防止
- ファイル転送、JSON/JSONL、Range、HLS
- Docker用イメージのバージョン表示、ベータ専用Compose、実機確認ガイド

## 検証

基礎実装の全705試験は合格しています。
ベータ版の対象試験12件も合格し、MCP initializeのバージョン、Docker設定、起動監視、SDK接続を確認しました。
初回リリースのタグ判定には4件の回帰試験を追加し、未作成・既存タグとAPI異常を確認しています。
コンテナ確認用設定にも2件の回帰試験を追加し、本番の認証設定検証を維持して正規のJWKSパスを使うことを確認しています。
版表示以外のAPI・認証・保存・executorの処理は基礎実装から変更していません。
ベータ版の全件回帰試験の再実行を示すものではありません。

Docker配布物はGitHub Actionsでlinux/amd64向けにビルドし、実コンテナで非root・読み取り専用起動、Compose設定の描画、health、同一ボリュームでの再起動を確認しています。
CIの上流は合成のバージョン応答です。実Immichの機能、Cloudflare、ChatGPTとの接続は実機での確認対象です。

## Dockerでの確認

AssetsのDocker用tar.gz、smoke.json、SHA256SUMSを同じ場所へ保存してください。

~~~sh
sha256sum -c immich-mcp-1.0.0-beta.1-linux-amd64.SHA256SUMS
docker load -i immich-mcp-1.0.0-beta.1-linux-amd64.tar.gz
~~~

イメージ名: immich-mcp:1.0.0-beta.1
配布イメージ: linux/amd64
手順: [BETA_DOCKER_TEST.md](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/blob/v1.0.0-beta.1/BETA_DOCKER_TEST.md)

ソース配布物にはDockerfile、compose.beta.yaml、設定例、試験と検証記録が含まれます。
鍵や実環境の設定値は含めていません。既存のプロジェクトライセンスと第三者資料の表示を維持しています。
