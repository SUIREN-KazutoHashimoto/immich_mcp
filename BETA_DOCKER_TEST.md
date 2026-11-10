# 1.0.0-beta.1 Docker実機確認

MCPアプリの最初のベータです。対応するImmich APIは **3.3.5** のままです。
以下はLinux Docker Engine + Docker Compose v2.24以降での手順です。
コンテナの起動確認と、実Immich・Cloudflare・ChatGPTを使う確認を分けて記録してください。

## 1. ソースとイメージ

~~~sh
git clone --branch v1.0.0-beta.1 --depth 1 https://github.com/SUIREN-KazutoHashimoto/immich_mcp.git
cd immich_mcp
~~~

[プレリリースのAssets](https://github.com/SUIREN-KazutoHashimoto/immich_mcp/releases/tag/v1.0.0-beta.1)から、Docker用の次の3ファイルを同じフォルダーへ保存します。

- immich-mcp-1.0.0-beta.1-linux-amd64.tar.gz
- immich-mcp-1.0.0-beta.1-linux-amd64.smoke.json
- immich-mcp-1.0.0-beta.1-linux-amd64.SHA256SUMS

~~~sh
sha256sum -c immich-mcp-1.0.0-beta.1-linux-amd64.SHA256SUMS
docker load -i immich-mcp-1.0.0-beta.1-linux-amd64.tar.gz
docker image inspect immich-mcp:1.0.0-beta.1 --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.version"}}'
~~~

配布イメージはlinux/amd64です。ソースからビルドする場合は、代わりに次を実行します。別アーキテクチャでの実行は未検証です。

~~~sh
docker build --tag immich-mcp:1.0.0-beta.1 .
~~~

## 2. 専用の設定・保存先

既存のMCPデータとは別の保存先を作成します。実際に使った保存先は控えてください。

~~~sh
export BETA_ROOT="$(mktemp -d "$HOME/immich-mcp-beta1.XXXXXX")"
mkdir -m 700 "$BETA_ROOT/private" "$BETA_ROOT/data"
cp .env.example "$BETA_ROOT/private/runtime.env"
chmod 600 "$BETA_ROOT/private/runtime.env"
printf 'BETA_ROOT=%s\n' "$BETA_ROOT"
~~~

runtime.envの次の値を利用環境に合わせて編集します。

- IMMICH_BASE_URL: 同じDockerネットワークから到達できるImmich API URL。例: http://immich-server:2283/api
- IMMICH_EXPECTED_VERSION: 3.3.5
- MCP_PUBLIC_BASE_URL: ベータ用HTTPSホスト。例: https://immich-mcp-beta.example.com
- ACCESS_ISSUER / ACCESS_AUDIENCE / ACCESS_JWKS_URL: 対応するCloudflare Accessの設定

Immich APIキーはenvファイルへ入れず、認証後の /connect で利用者ごとに登録します。

~~~sh
cat > "$BETA_ROOT/private/stack.env" <<EOF
MCP_IMAGE=immich-mcp:1.0.0-beta.1
NODE_IMAGE=node:24.22.2-bookworm-slim
MCP_ENV_FILE=$BETA_ROOT/private/runtime.env
MCP_DATA_DIR=$BETA_ROOT/data
MCP_MASTER_KEY_FILE=$BETA_ROOT/private/vault.key
IMMICH_NETWORK=immich_default
MCP_TEST_PORT=3000
EOF
chmod 600 "$BETA_ROOT/private/stack.env"
~~~

IMMICH_NETWORKは対象Immich APIコンテナが所属する既存ネットワーク名へ変更します。
ポート3000が使用中ならMCP_TEST_PORTを変更します。

新規保存先の鍵を、イメージ同梱CLIで一度だけ作成します。既存ファイルは上書きしません。

~~~sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$BETA_ROOT/private,target=/private" \
  --entrypoint node immich-mcp:1.0.0-beta.1 \
  dist/scripts/init-key.js /private/vault.key
sudo chown 1000:1000 "$BETA_ROOT/data" "$BETA_ROOT/private/vault.key"
sudo chmod 700 "$BETA_ROOT/data"
sudo chmod 400 "$BETA_ROOT/private/vault.key"
~~~

鍵はdataディレクトリの外に保管し、同じデータの再起動では同じ鍵を使用します。
Windows Docker DesktopではLinuxコンテナを選び、絶対パスとマウントした鍵・dataの読み書き権限を確認してください。

## 3. 起動と確認

専用compose.beta.yamlはMCPコンテナだけを起動します。Tunnelトークンは不要です。
実行ユーザー1000:1000、読み取り専用ルート、分離した鍵・data、認証の検証を維持します。
ホストへ公開するのは127.0.0.1の確認用ポートだけです。

~~~sh
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml config --quiet
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml up -d --no-build
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml ps
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml exec -T mcp node dist/scripts/healthcheck.js live
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml exec -T mcp node dist/scripts/healthcheck.js ready
~~~

両CLIがok:trueなら、プロセスと保存領域・鍵・固定アセット・上流バージョンの確認が通っています。
readyはCloudflareやChatGPTの接続成功を意味しません。

/connect と /mcp は引き続き有効なAccess JWTと正しいHostを要求します。
localhostのHTTPをそのまま認証済み画面として使うことはできません。
実際のHTTPS経路は[DEPLOYMENT.md](DEPLOYMENT.md)のTunnel/Access設定を使ってください。
Dockerネットワーク上のベータ用接続名は immich-mcp-beta1:3000 です。
既存Tunnelコンテナから使う場合は対象ネットワークへ接続し、originのHostをMCP_PUBLIC_BASE_URLに合わせます。

確認項目:

1. HTTPSの /connect でAccess認証し、本人のImmichキーを登録できる。
2. MCP initializeがアプリ版1.0.0-beta.1を返し、9ツールと279操作を参照できる。
3. A/Bのキー・結果・ファイルが混ざらず、権限不足では上流の拒否が保持される。
4. 再起動後も同じdataと鍵で起動し、未確定の書き込みが自動再実行されない。

~~~sh
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml restart mcp
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml exec -T mcp node dist/scripts/healthcheck.js ready
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml logs --tail 100 mcp
~~~

再起動直後のreadyがまだfalseなら、初回確認の完了後にもう一度確認します。
終了時はdownでコンテナを停止します。dataと鍵はホスト側に残ります。

~~~sh
docker compose --env-file "$BETA_ROOT/private/stack.env" -f compose.beta.yaml down
~~~

全機能の隔離Immich試験は[INTEGRATION.md](INTEGRATION.md)、バックアップと復旧は[OPERATIONS.md](OPERATIONS.md)を参照してください。
不具合報告にはアプリ版、Immich版、CPU/OS、イメージID、readyの結果と秘匿値を除いたログを添えてください。

## 検証の範囲

基礎実装はローカル705試験に合格しています。ベータ版のバージョン表示・Docker設定の対象試験は
[reports/beta.1-verification.json](reports/beta.1-verification.json)に記録します。
配布イメージのsmoke.jsonは、実Dockerでの非root・読み取り専用起動、health、同一ボリュームでの再起動を確認したものです。
その上流は合成のバージョン応答で、実Immichの機能、Cloudflare、ChatGPTの検証結果には数えません。

参考: [Compose build](https://docs.docker.com/reference/cli/docker/compose/build/)、[Compose services](https://docs.docker.com/reference/compose-file/services/)。
