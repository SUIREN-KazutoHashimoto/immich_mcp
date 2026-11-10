# Immich 3.3.5 MCP 実装仕様パッケージ

この一式をCodexの作業ディレクトリへ展開し、最初に **CODEX_HANDOFF.md** を読ませてください。

## 読む順序

1. `CODEX_HANDOFF.md`: 実装の目的、優先順位、禁止する省略、成果物。
2. `Immich_MCP_v3.3.5_Specification.md`: 全22章の詳細仕様。
3. `api/source-manifest.json` と `api/immich-openapi-v3.3.5.json`: 固定した公式原本。
4. `api/operation-inventory.md` / `.json`: 全279操作の一覧。
5. `contracts/`: 認証条件、実通信の補正、MCP wrapper契約。
6. `verification/`: このパッケージに対する検証記録。

## 基準

- Immich: 3.3.5
- Commit: `8303cb117e197c700332b33b61b45314c9cc5bb4`
- 公式API: **279 operations / 193 paths / 41 primary tags**
- OpenAPI SHA-256: `632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9`

通常の呼び出しは本人のAPIキーを使い、最終認可をImmichに委譲します。全APIの実装対象から管理・変更・削除機能を除外しません。

ただし、Immichがセッションや共有リンク等を要求する機能、公開API、保守runtimeでは、APIキーのpermissionsだけでは認可を表現できません。詳細仕様第1章・第7章と認証契約を必ず読んでください。通常キーの拒否を別の資格情報で自動回避する設計は含めていません。

## 添付資料の検証

パッケージのrootから実行します。

```bash
python3 api/verify_openapi_inventory.py
python3 verification/verify_package.py
sha256sum -c SHA256SUMS
```

台帳を再生成する場合:

```bash
python3 api/build_inventory.py
python3 api/verify_openapi_inventory.py
```

`build_inventory.py` は同梱の原本と抽出済み認証情報を使います。全controllerのコピーや本番接続は不要です。

## このパッケージに含まれるもの

詳細仕様、Codexへの引き継ぎ、公式OpenAPI原本、全操作の台帳、認証・通信・秘密fieldの補正契約、再生成/検証用Pythonスクリプト、公式LICENSE、完全性manifestです。

**稼働するMCPアプリ、配備済み環境、APIキー、実データは含まれていません。** アプリケーションの実装・統合試験・ChatGPT疎通試験は、これからCodexが行う作業です。

verificationの成功はこの仕様パッケージの整合性を意味します。将来の実装が全279操作に合格したことを意味しません。

## 参照

公式URLは詳細仕様第22章、原本の由来とhashは `api/source-manifest.json` にあります。操作ごとの公式source URLも台帳と補正契約に収録しています。上流原本と同じcommitのLICENSEを `api/LICENSE.immich` に同梱しています。

この構成にした理由は、全APIの範囲・利用者分離・上流の認証例外を、実装者が再現可能な形で確認できるようにするためです。
