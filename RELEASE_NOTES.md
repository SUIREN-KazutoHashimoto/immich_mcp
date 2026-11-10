# Immich MCP 1.0.0-beta.1

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
