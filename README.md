# Immich MCP 1.0.0-beta.3

この開発ソースには未リリースの画像連携修正を含みます。`immich_read_image` がモデル向け画像を返し、既存の9ツールと合わせて10ツールになります。導入とChatGPTでの確認は [画像連携の確認手順](CHATGPT_IMAGE_TEST.md) を参照してください。公開済みbeta.3イメージにはまだ含まれません。

beta.3は接続画面の標準フォームが`Origin: null`になり、キー登録を拒否される不具合を修正します。HTMLのReferrer-Policyを`same-origin`にし、正規OriginとCSRFの検証、外部サイトへのReferer送信抑止を維持します。

Immich **3.3.5 / 3.3.6** に対応します。公式OpenAPIを比較した結果、3.3.6の差分は `info.version` のみで、全279操作・スキーマとサーバーのAPI実装に変更はありませんでした。固定API定義は3.3.5の原本を維持し、未検証のパッチ版・マイナー版・プレリリースは拒否します。比較元のコミットとハッシュは [互換性記録](reports/immich-3.3.6-compatibility.json) にあります。

TrueNASのCustom App GUIでは `ghcr.io/suiren-kazutohashimoto/immich-mcp:1.0.0-beta.3` を指定します。利用者ごとのキー、暗号化データ、別マウントのマスター鍵、Cloudflare Access認証の仕組みは共通です。以下のbeta.1に関する記録とアーカイブ手順は初回ベータの履歴です。

**1.0.0の最初のベータです。対応APIはImmich 3.3.5です。** Dockerの実機確認は [BETA_DOCKER_TEST.md](BETA_DOCKER_TEST.md) を参照してください。GitHubのプレリリースにソースとlinux/amd64のDocker配布物をまとめます。

A TypeScript implementation for a multi-user Immich MCP server based on the bundled fixed specification. The target remains all 279 official operations, the nine baseline MCP tools plus the image-reading extension and the complete deployment/acceptance requirements. Each user registers their own Immich API key; authorization remains with Immich.

## Current state

Implementation and local verification are the current delivery stage. Real Immich/Linux/container, Cloudflare and ChatGPT acceptance is deferred at the user's request.

The service implements all279 official operations through the common serializer/executor and the nine baseline MCP tools plus the image-reading extension. It includes caller-owned encrypted credentials and results, explicit session/shared-link/public/setup/maintenance contexts, persistent jobs with uncertain-outcome fencing, resumable browser uploads, streaming JSON/JSONL and binary/Range/HLS adapters. Authentication remains with Immich; an API-key refusal never triggers automatic credential fallback.

Verification baseline: the preceding implementation passed all705 local tests/nine suites, with190 unchanged selected inputs. The beta release changes the application version reported by MCP initialize and Docker metadata, plus adds a dedicated beta stack and release CI. API version3.3.5, operation definitions, authentication, storage and executor behavior are unchanged. Release-focused checks are recorded separately in reports/beta.1-verification.json; a new full regression run of the beta release is not claimed. The image smoke uses real Docker with a synthetic upstream and does not establish actual Immich/Cloudflare/ChatGPT acceptance.

| Scope | Implemented | Local evidence | Real integration / upstream refusal | Unmet environment conditions |
| --- | --- | --- | --- | --- |
| All279 operations / ten MCP tools | Yes | Original nine-tool baseline: 705 tests. Image extension and related paths: 50 targeted tests; see reports/image-content-verification-2026-11-11.json | Not run / synthetic403 only | Isolated Immich and real gateway/client |
| Authentication, protected storage, jobs and special transports | Yes | Native synthetic HTTP, browser, persistence and failure tests passed in the complete705-test regression | Not verified | Real accounts, network and runtime |
| Eleven isolated feature fixture plans | Yes | All eleven local fixture groups included in the complete705-test regression | All41 actual category gates unverified | Disposable Docker lab; conditional OAuth/library/SMTP/maintenance setup |
| Backup/rekey/restore/retention and readiness | Yes | Local crash/WAL/recovery and configuration tests | Linux/volume behavior unverified | Linux container host |
| Container deployment and Cloudflare/ChatGPT connection | Templates and instructions | Local configuration checks | Not run | Reviewed image digests, Tunnel/Access configuration and client connection |

The eleven feature-plan source modules statically reference33 of41 primary tags; eight tags have no feature-plan literal references. This planning metric does not establish category acceptance or omit their generic execution paths. reports/operation-coverage.json records implemented wire coverage separately from unverified real success/refusal conditions.

Schema validation uses content-matched detached JSON schemas in a bounded LRU cache: at most256 entries and8MiB of serialized schema content. Each compiled entry has its own Ajv scope. This is not a whole-process memory cap.

## Development

Requires Node.js 24 and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm generate
pnpm build
pnpm test
```

Verify the unchanged specification separately:

```sh
python immich_mcp_spec_v3.3.5/api/verify_openapi_inventory.py
python immich_mcp_spec_v3.3.5/verification/verify_package.py
```

Browser tests use installed Microsoft Edge on Windows. Elsewhere run `pnpm exec playwright install chromium`. MCP_TEST_BROWSER_CHANNEL selects another installed browser channel. These tests simulate the gateway and do not prove real Cloudflare or ChatGPT connectivity.

## Isolated backend test environment

See INTEGRATION.md for prepare/up/check/bootstrap and the feature commands below. Each independent plan needs its own fresh, signed, disposable lab with dedicated volumes and a loopback endpoint. Bootstrap provisions a synthetic administrator, users A/B and separately verified keys; protected inputs and responses stay in the encrypted fixture vault. Uncertain mutations are never automatically replayed. Completed validation repeats only the recorded non-mutating cases.

| Feature command | Usual initial semantic cases | Read-only repeat |
| --- | ---: | ---: |
| fixtures | 42 | 26 |
| auth-fixtures | 60 | 17 |
| video-fixtures | 40 | 20 |
| sync-fixtures | 72 | 11 |
| collection-fixtures | 109 | 37 |
| sharing-fixtures | 105 | 30 |
| user-fixtures | 126 | 44 |
| discovery-fixtures | 90 | 50 |
| people-fixtures | 237 | 46 |
| lifecycle-fixtures | 219 | 36 |
| workflow-fixtures | 185 | 56 |

Counts describe the normal local harness paths, not actual-server execution or acceptance. Fault/polling paths may differ. Source provenance, exact byte/state assertions, refusal semantics and remaining conditions are documented in INTEGRATION.md. HLS and sync-stream GET requests that change server state are treated as mutations and excluded from read-only repeats. Physical deletion, automatic ML effects, external email delivery and plugin WASM execution are not established by the local models.

New runs use signed payload version2 with all four image references pinned to digests. Authenticated v1 runs retain their original references and lifecycle; no existing run is automatically migrated. up/check validate the selected template before Docker, and owned teardown remains possible without configuration files. Docker execution is not available in this development environment.

## Local runtime configuration

Copy .env.example to .env and replace its example URLs, Access issuer, audience and JWKS URL. Create a master-key file at an explicit absolute path outside the data volume, with an existing parent:

```sh
pnpm keygen /absolute/private/path/immich-mcp-master.key
```

On Windows use a path such as C:/Users/your-user/private/immich-mcp-master.key. This writes 32 raw random bytes without printing them or overwriting an existing file. Set VAULT_MASTER_KEY_FILE to this separate secret.

Build, then load .env with Node:

```sh
node --env-file=.env dist/src/main.js
```

`pnpm start` uses an already exported environment. Users register their own Immich keys in the authenticated /connect screen. Both /connect and /mcp require a valid Access assertion. No shared IMMICH_API_KEY setting is used.

Self-rotation of the active Immich API key commits its new secret, saved result and job receipt together. The rotation receipt remains available under that exact new binding; other old results remain invalid. Failed local commits retain an explicitly uncertain display and never replay the operation. Large encoded responses use validated projected fields. See OPERATIONS.md for authenticated key recovery and context revalidation.


Expiry cleanup runs at startup and every CLEANUP_INTERVAL_SECONDS (default 60). Active jobs, captures and original readers are protected. Old unreferenced credentials and expired records/objects/indexes are removed; old orphan objects use a five-minute grace period. Failed file deletions retain metadata for retry. A cleanup failure makes readiness unavailable while diagnosis remains possible. Job polling loads data through the original result retention boundary and cannot revive expired display bodies.

The /health/live endpoint reports process availability. /health/ready checks upstream version, cleanup, DB writes/ledger, schema, authenticated master key, owner identity, storage writes and fixed runtime assets. A missing/changed configured key file also fails readiness. Local checks run at startup and every 30 seconds; readiness requests share the cached/in-flight check. Only statuses/timestamps are exposed. Detected local failures stop new API executions and control-UI POST changes while liveness remains available. Real Cloudflare routing and ChatGPT connection are unverified.

FILE_SOURCE_ALLOWED_HOSTS is an exact DNS-host list for trusted attachments. Its empty default disables external downloads; resumable browser uploads remain available. MAX_UPLOAD_BYTES defaults to 1 GiB. DATABASE_PATH, MAX_RESULT_BYTES, INLINE_RESULT_MAX_BYTES, JSON_VALUE_MAX_BYTES, RESULT_TTL_SECONDS, STAGING_TTL_SECONDS and MAX_JOBS_PER_PRINCIPAL are supported. MAX_UPSTREAM_CONCURRENCY defaults to 8, UPSTREAM_CONNECT_TIMEOUT_MS to 10000 and UPSTREAM_IDLE_TIMEOUT_MS to 30000. The shared FIFO limit covers transfer and subsequent result inspection. Pending execution is revalidated only when capacity is available, before marking a job sent or consuming an OAuth callback. Header/body idle timeouts and explicit cancellation replace the previous fixed two-minute execution deadline; no automatic operation retry or credential fallback is used.

STORAGE_QUOTA_BYTES defaults to 3 GiB per principal; GLOBAL_STORAGE_QUOTA_BYTES defaults to 12 GiB for the shared store. Both include encrypted record payloads, encrypted original-file bytes and unused reserved capacity. SQLite/index/WAL space and filesystem overhead are excluded: provision additional volume headroom. The authenticated /connect screen shows only the caller's usage and per-principal limit.

Uploads reserve space for chunks plus assembly and metadata; transfers convert reservations into actual bytes without double counting. Accepted jobs retain a 64 KiB status allowance. Before sending, normal JSON execution reserves twice the inline limit plus 576 KiB for terminal metadata (832 KiB at the default inline limit); binary execution reserves 192 KiB. Insufficient space rejects a new execution before sending. Exhaustion after sending retains an explicitly incomplete original and an uncertain outcome, without automatic replay. Failed physical deletions remain charged until removal succeeds. Startup reconciles actual object sizes and interrupted allocations, including legacy pending uploads/jobs.

The storage directory holds a persistent owner identity bound to an authenticated identity in its database. A different database is rejected before object reconciliation, including after shutdown; a cleanly moved copy of the same database retains its identity. Keep .storage-owner.sqlite with its matching database and objects. Do not reset owner metadata to make an unrelated database start. First opening a pre-identity vault requires its original verified master-key check; a fresh database cannot adopt existing object files.

## Container deployment

Dockerfile and compose.yaml provide a non-root, read-only runtime with dedicated data/tmp paths, separate key/token secrets, no host-published port and private Tunnel/Immich networks. The container healthcheck tests liveness; upstream downtime separately fails readiness. Build copies preserve the fixed API bytes after TypeScript compilation.

See [DEPLOYMENT.md](DEPLOYMENT.md) and deploy/.env.example for exact configuration, image/version references, permissions, startup and acceptance gates. Docker is absent in this development environment. Configuration policy, the real health CLI and a standalone compiled bundle are tested locally; image builds, Linux secret mounts and cloudflared execution are not yet verified.

## Vault maintenance

The store records schema/cipher/key versions and authenticates the version as part of record encryption. Legacy metadata migration is transactional. Offline backup reads schema 1 or 2 without migrating the source, preserves generated orphan ciphertext and produces a signed non-runnable archive. Restore creates a fresh generation, quarantines all pending snapshot jobs and disables additional authentication contexts; valid local upload chunks can resume. Offline rekey reencrypts a separate verified generation while preserving references. Retention plans preserve the newest eligible backups and skip unverifiable archives or unrelated files; explicit apply rechecks contents and supports recovery after process death. See [OPERATIONS.md](OPERATIONS.md) for backup/restore/rekey/verify and retention commands, key separation, activation and rollback limits.

## Results and streams

Received wire bodies are encrypted and durably saved before inspection. JSON responses are then tokenized from the saved original with backpressure, validated and stored as encrypted display trees. Large arrays and nested objects can be paged using /data JSON Pointers without loading the complete response. Known secret fields are replaced before display storage; raw original bytes remain separate.

The default result limit is 1 GiB, the inline display limit is 128 KiB and each inspected scalar/union is bounded to 1 MiB. MAX_RESULT_BYTES, INLINE_RESULT_MAX_BYTES and JSON_VALUE_MAX_BYTES configure these limits. MAX_DECODED_RESULT_BYTES defaults to MAX_RESULT_BYTES and bounds every decompression stage as well as the final inspected bytes. Supported HTTP encodings are gzip/x-gzip, deflate, Brotli and Zstd, including up to four stacked codings; Zstd decoding uses an 8 MiB maximum window. Verification probes separately bound wire and decoded bytes. An exceeded inspection limit is an explicit failed display with the original retained. Unknown arbitrary JSON values are explicitly withheld.

Tool responses contain a principal-bound result_ref. immich_read_result reads only the sanitized display. Original-byte downloads are available through authenticated control-UI submission; originals may contain credentials. The control UI distinguishes complete, incomplete and legacy unverified transfers. Incomplete downloads use a .partial.bin filename; unverified downloads use .unverified.bin. The response includes x-immich-original-completeness and, when recorded, the received-byte SHA-256. A partial file contains only received bytes and is not a complete backup. Content-encoded originals use an additional .encoded suffix. The UI and x-immich-original-content-encoding header explain the stored coding; downloads deliver exact encoded wire bytes without an HTTP Content-Encoding header that would silently decode them.

For sync streams, use mode:"jsonl" with offset/limit or the returned cursor. JSON Pointers in this mode address the records array, for example /80/data/name. The normal JSON view also accepts /data/80/data/name. Metadata reports count, terminal, stream completeness and original-transfer status.

JSONL is parsed incrementally and stored as encrypted display pages. PIN fields become secret_ref objects. Unconstrained JSON values are explicitly withheld; their originals remain available in the control UI. Malformed lines, unknown shapes, missing terminals and interruptions preserve the valid prefix and return failed/outcome_unknown states. No automatic replay occurs.

Additional contexts are connected explicitly in the control UI and do not inherit API-key permissions. Session ownership is checked against the caller's current key ID. Normal API-key calls never automatically switch context after refusal.

## Evidence

DEVELOPMENT.md records the detailed evidence and failure/fix history. reports/operation-coverage.json separates all279 core wire checks from unverified real integration and full acceptance. The original OpenAPI, provenance and license remain bundled; dependencies are pinned.

The reviewed response/transport corrections are restricted to their version, commit, source fingerprint and exact operation/status/schema positions. They cover duplicate activities, cluster invitations, nullable search suggestions, time-bucket status, asset-file Range, zero-based workflow log indexes and nullable plugin method schemas. Original global schemas remain unchanged. Unknown statuses/fields and encrypted originals retain their protection.

The current empty-sync fix and190-file source delta are recorded in reports/empty-sync-source-delta-2026-11-10.json. Its independent terminal probe and regression tests preserve exact empty payloads while nonempty arbitrary objects remain withheld. The complete705-test regression and matching-source audit pass. The source package includes the final result, audit and per-file manifest; historical reports remain in the development workspace.

No production Immich endpoint, credentials, Access application or ChatGPT connector was configured by these tests. No production data was changed.


## License and upstream material

このプロジェクトで独自に作成した内容には既存の [Apache License 2.0](LICENSE) を適用します。第三者の定義・資料のライセンスは維持し、再ライセンスを主張しません。現在はImmich3.3.5のOpenAPI原本と生成定義を同梱しています。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) と同梱の元ライセンス・出典を参照してください。このプロジェクトはImmichの非公式連携プロジェクトです。
