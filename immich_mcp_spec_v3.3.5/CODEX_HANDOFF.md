# Codexへの実装指示: Immich 3.3.5 専用MCP

このパッケージの詳細仕様に従い、複数利用者が自分のImmich APIキーで利用するリモートMCPサーバーを実装してください。対象は **Immich 3.3.5**、Cloudflare TunnelとAccess Managed OAuth経由でChatGPTから接続する構成です。

## 最優先の要求

1. 同梱の固定OpenAPIにある **279操作すべて** を実装してください。管理、変更、削除、バックアップ、復元、システム設定、ユーザー、APIキー管理、Alpha/Beta/Deprecated/Internalも対象です。
2. 通常の呼び出しは、検証済みAccess主体に紐付く本人のAPIキーだけを使用してください。権限はImmich本体のAPIキーpermissionsと上流の所有者・管理者・状態判定に委譲します。
3. MCP独自の機能allowlist、read-onlyモード、管理/削除APIの一律禁止を追加しないでください。
4. 401/403を受けて管理者キー、別利用者のキー、session、shared linkへ自動切替しないでください。
5. API一覧を作っただけで実装完了としないでください。全operationのserializer、executor、response/error handlerとwire契約テストが必要です。

## 最初に読むもの

- `Immich_MCP_v3.3.5_Specification.md` 全文。特に第1章、第5〜12章、第18〜20章。
- `api/immich-openapi-v3.3.5.json` と `api/source-manifest.json`。
- `api/operation-inventory.json` / `api/controller-auth-index.json`。
- `contracts/auth-contexts.v3.3.5.json`。
- `contracts/operation-overrides.v3.3.5.json`。
- `contracts/mcp-tool-contracts.json`。

原本のcommitは `8303cb117e197c700332b33b61b45314c9cc5bb4`、SHA-256は `632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9` です。main/latestの定義へ無断で置き換えないでください。

## 認証について誤解してはいけない点

Immich 3.3.5では、全APIの実装と「APIキーだけで全機能が成功すること」は同じではありません。同期・session lock/unlock等にはsession、共有リンク閲覧者のAPIには共有リンク認証、保守runtimeには別の資格情報が必要です。公開APIにはAPIキーscopeによる認可がありません。

通常の `immich_api_call` は全279操作を本人APIキーで呼び、上流の拒否をそのまま返します。特殊認証adapterも実装してください。ただし本人がcontrol UIで明示的に接続したcontextを別経路で使い、通常キーのscope不足を自動回避しないでください。追加contextにはAPIキーscopeが継承されないことを説明してください。

汎用sessionによる通常API実行やPIN保護asset対応を、既定のAPIキー経路へ黙って開放しないでください。別モード・追加workflowとして設計し、未接続時は必要条件を明示します。これを理由にoperationをカタログから消したりstubに置き換えたりしないでください。

## 実装の進め方

1. パッケージの検証スクリプトを実行し、原本と台帳の完全性を確認します。
2. 既存repositoryの構成・規約・既存変更を確認し、実装計画と進捗を簡潔に記録します。
3. 固定原本から決定的なレジストリとschema処理を生成します。
4. 本人識別・vault・キー登録を実装します。登録検証はgetMyApiKeyを使い、user.readの追加を要求しません。
5. 少数の固定MCPツールと全279操作の共通executorを実装します。
6. ファイル、JSONL、HLS、redirect、Cookie、secret、job、特殊認証adapterを完成させます。
7. 全279のwire契約テスト、隔離Immich 3.3.5での統合テスト、Cloudflare/ChatGPT接続試験を行います。
8. Docker配備手順、秘密のない設定例、復旧・更新手順、operation単位のcoverage reportを提出します。

最初の段階を読み取り機能から始めることは可能ですが、最終成果物を読み取り専用MVPで打ち切らないでください。

## 必須の通信補正

JSONだけのHTTP proxyでは完了になりません。少なくとも次を扱います。

- uploadAsset、createProfileImage、uploadDatabaseBackupのmultipart。
- logoutOAuthのURL-encodedフォーム。
- 画像、動画、ZIP、バックアップの元bytesとRange。
- HLS4操作と専用header、session生成/終了等の副作用。
- getSyncStreamのJSONLと途中切断、行内の秘密field。
- redirectOAuthToMobileの307、viewAssetの302、uploadAssetの200/201差。
- API key/session secret、管理設定のclientSecret/SMTP password、共有リンク認証材料、Set-Cookie。
- 原本保存とモデル表示の区別。read_resultやJSON Pointerで秘密を再取得できないこと。

補正JSONは既知事項の仕様データです。全runtimeの監査完了やアプリ実装完了を意味しません。未知の差は固定commitの公式sourceと隔離試験で確認し、根拠付きで補正・テストへ追加してください。

## 完了報告

公式のoperationId/method/pathと実装の集合差を示し、missing/unexpected/duplicateが空であることを確認してください。操作ごとに、実装済み、wire試験済み、統合成功、上流拒否確認、環境条件未充足を分けて報告してください。

実domain、内部URL、Access audience、秘密等が未入力でも、実装・mock試験・隔離環境・設定テンプレートを進めてください。実値を推測して運用環境へ接続したり、稼働中の写真や利用者を破壊的テストに使ったりしないでください。必要な実環境の接続条件だけを最後に具体的に示してください。

この指示の理由は、公式APIの範囲を縮めずに実装しながら、本人の認証とImmich本体の権限判定を維持し、非JSON通信や認証例外を未実装のまま見落とさないようにするためです。
