# immich_mcp

Immichの公式HTTP APIを、Model Context Protocol（MCP）経由で利用するための独立したサーバープロジェクトです。

**開発状況：リポジトリの準備段階です。サーバー本体は未実装で、インストール・起動手順と動作確認結果はまだありません。**

## 実装目標

| 項目 | 方針 |
| --- | --- |
| 対象バージョン | Immich 3.3.5を初期のAPI仕様基準とする |
| APIの範囲 | 対象バージョンの公式OpenAPIに記載された全操作を実装対象とする |
| 利用者の分離 | 認証済みの利用者と本人のImmich APIキーを紐付け、他の利用者のキーと分離する |
| 操作権限 | 通常のAPIキー経路では、Immich本体の権限判定に従う |
| MCPの接続 | Streamable HTTPを想定する |
| 公開経路 | Cloudflare Tunnel経由の運用と、Cloudflare Access Managed OAuthによる利用者認証を想定する |

上記は今後の実装目標であり、対応済み機能や接続確認済みの構成を示すものではありません。

## 設計方針

- Immich本体とは独立したHTTP APIクライアントとして実装する。
- 通常の呼び出しには、接続中の利用者に紐付いた本人のAPIキーを使用する。
- 操作ごとの利用可否はImmich側で管理し、MCP独自の機能許可リストで一律に制限しない。
- 権限不足の際に、管理者・他の利用者のキーやセッションへ自動的に切り替えない。
- APIキーでは利用できない操作についても、上流の認証条件を明示する。追加認証を扱う場合は本人の明示的な接続を必要とし、APIキーの権限と同一視しない。
- APIキー・トークン・実データをリポジトリへ含めない。設定例を追加する際はダミー値を使用する。

実装言語・依存パッケージ・ビルド方法は、実装開始時に決定します。

## ライセンス

このプロジェクトで独自に作成した内容には、[Apache License 2.0](LICENSE)を適用します。

第三者のコード・定義・資料を取り込む場合、その著作権表示と適用ライセンスを保持します。本プロジェクトのライセンス表示は、第三者の著作物を再ライセンスするものではありません。

Immich 3.3.5本体と公式TypeScript SDKはAGPLv3です。公式SDK・ソースコード・OpenAPI原本や生成物の採用時には、対象ファイルの条件と、配布物全体への影響を確認します。フォルダの分離や表示の追加だけで、この確認を代替しません。

現時点では、Immichのソースコード・SDK・OpenAPI原本・生成物を同梱していません。

このプロジェクトはImmichの非公式連携プロジェクトです。

## 公式資料

- [Immich APIドキュメント](https://docs.immich.app/api/)
- [Immich v3.3.5のOpenAPI定義](https://github.com/immich-app/immich/blob/v3.3.5/open-api/immich-openapi-specs.json)
- [Immich v3.3.5のライセンス](https://github.com/immich-app/immich/blob/v3.3.5/LICENSE)
- [Immich v3.3.5の公式SDKメタデータ](https://github.com/immich-app/immich/blob/v3.3.5/packages/sdk/package.json)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
