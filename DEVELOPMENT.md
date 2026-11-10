# Development and acceptance tracking

## Scope

The full bundled specification remains the objective: all 279 operations, nine MCP tools, user isolation, Cloudflare/ChatGPT, special authentication, files/streams, durable jobs and operational deliverables. Local passing tests do not complete that scope.

## Verified evidence (2026-11-10)

- Original inventory and specification-package verification pass. Fixed source: 279 operations, 193 paths, 41 primary tags, SHA-256 632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9.
- Deterministic generation checks operation triples, overrides, secret rules, authentication contracts and sync record mappings.
- TypeScript builds on Node.js 24.22.1. pnpm check completes generation, TypeScript build and all 573 regression tests with zero failures, cancellations or skips. This run includes crashed-source WAL recovery, signed retention, process-death resumption, runtime readiness, a standalone built bundle, the deployment health CLI and the actual browser workflow.
- Every operation reaches a real local HTTP mock through the common executor. Tests verify method, path, caller's sole API key, body, declared success and refusal. Multipart is independently parsed; encrypted original bytes are recovered and compared.
- reports/operation-coverage.json records 279 core-wire passes with empty missing/unexpected/duplicate sets. Real integration and full feature acceptance remain incomplete.
- Native HTTP tests cover Access JWT, Host/Origin, nine stable tools, catalog/describe/call/results, keyless public and session jobs, files/multipart, isolation, cancellation and readiness.
- Transport tests use legacy 2025-11-25 JSON-RPC and official MCP client/server SDK 2.4.0 pinned to 2026-07-28. Modern discovery, listing, call outputs and per-request protocol headers pass.
- JSONL validates all 57 currently emitted SyncItem types against pinned schemas. The DTO/service mapping was read from fixed commit 8303cb117e197c700332b33b61b45314c9cc5bb4. Six retired enum entries are inventoried separately. Unexpected types retain encrypted raw bytes and fail projection explicitly.
- JSONL tests cover UTF-8/line splits, ordering, paging beyond inline limits, PIN replacement, pointers, arbitrary JSON withholding, malformed/unknown records, missing/extra terminals, reset, bad MIME, interrupted transfers, failed jobs and actual SQLite close/reopen persistence.
- Explicit key generation writes 32 raw random bytes to a supplied absolute path and refuses overwrite. Tests create temporary keys only.
- Headless Edge exercises resumable uploads, lost acknowledgements, reselection verification and explicit replacement. The gateway is simulated.

## Implemented modules

- Registry, schema, catalog and describe: src/registry.ts, src/schema.ts, scripts/generate.ts.
- All-operation serializer/executor: src/serializer.ts, src/executor.ts.
- AES-256-GCM principal-bound records and original objects: src/vault.ts.
- Secrets, known union variants, unknown-structure protection and RFC 6901: src/projection.ts.
- Access JWT, Origin and HMAC CSRF: src/access.ts.
- Authenticated keys/secrets/originals/context/upload/job controls: src/control.ts, src/context-control.ts.
- Trusted-host downloads with public-address validation, pinned DNS and per-redirect checks: src/download.ts.
- Encrypted staging with quota reservations: src/staging.ts.
- Resumable encrypted uploads and browser UI: src/uploads.ts, web/upload.js.
- Explicit session/shared-link/public/setup/maintenance contexts, owner verification, mode consent and OAuth state/callback handling: src/contexts.ts.
- Persistent fair context-aware jobs, before-send revalidation, cancellation, single ownership and conservative startup recovery: src/jobs.ts.
- Incremental JSONL, pinned record adapter and encrypted display pages: src/jsonl.ts, src/sync-projection.ts, src/result-pages.ts, contracts/sync-records.v3.3.5.json.
- Streaming ordinary JSON, sanitized external-memory trees and model-facing paging/metadata: src/json-projection.ts, src/json-tree.ts, src/views.ts.
- Expiry/orphan/key cleanup with active-handle protection: src/cleanup.ts, src/vault.ts.
- Shared per-principal/global encrypted storage accounting, transferable reservations and startup reconciliation: src/storage.ts.
- Persistent database/storage-root identity and exclusive directory ownership: src/vault.ts.
- Stable SDK tools and schemas: src/tools.ts.
- Listening application, startup/version readiness and coordinated shutdown: src/app.ts, src/http.ts, src/main.ts.
- Supported configuration example and explicit key helper: .env.example, scripts/init-key.ts.

## Security and lifecycle behavior

Normal execution uses one caller API-key snapshot. A 401/403 never triggers retry or another credential. Incoming Access assertions/client bearer tokens never reach Immich or attachment hosts. Upstream refusal stays a tool error over valid MCP transport.

Session ownership is proved using getMyApiKey and then that exact key ID with the candidate session. Sessions start in a restricted workflow mode; general-session/PIN workflows require separate acknowledged control-UI consent. Key updates pause dependent contexts until owner revalidation. Public/setup and maintenance can work without a normal key.

Jobs retain their accepted context, generation and callback provenance. Preflight/cancellation do not consume OAuth callbacks; actual sending consumes one validated callback. Recent jobs/request IDs recover lost acknowledgements. Accepted durable jobs run independently of the initial MCP request; explicit cancellation and shutdown abort transfers conservatively.

Result access checks binding/context generation. Every model-facing read uses display data. Known secrets are references; arbitrary JSON values are explicitly withheld. Originals require an authenticated Origin/CSRF-protected control-UI submission and attachment/nosniff/no-store delivery.

Malformed JSONL retains received bytes and the sanitized valid prefix. Interrupted transfers retain an explicitly incomplete encrypted original with received size/hash and return outcome_unknown. Normal sync completion requires SyncCompleteV1 or SyncResetV1. A broken line is never skipped into successful EOF. No automatic replay occurs.

SQLite EXCLUSIVE locking owns the database until close. Tests prove a second process cannot reinterpret live work as crashed. Queue recovery occurs once per application, not per SDK request.

## Remaining work

1. Verify runtime readiness and schema/key recovery with actual Linux/container mounts and volume durability. Local operational checks, authenticated backup/restore, snapshot-job quarantine, context/OAuth invalidation, legacy migration and re-encryption are implemented. OS/power-loss validation is unperformed; binary rollback requires schema compatibility.
2. Expand the implemented media and explicit PIN/session/shared-link fixture phases with short video and the remaining category/special-adapter cases, then verify all 41 categories and special workflows against isolated real Immich 3.3.5, including ownership/admin/permission changes, cookies/runtimes, binary/HLS, multipart, sync, OAuth and maintenance. There is no browser HLS player; adding one would require an authenticated playlist relay.
3. Build and run the supplied Dockerfile/Compose configuration and execute deployment/update/recovery procedures on a real Docker host. Docker is absent from the current Windows environment; image pulls/runtime digests, Compose rendering, Linux non-root/secret permissions, cloudflared and container acceptance remain unperformed.
4. Configure/test real Cloudflare Access/Tunnel/Managed OAuth and ChatGPT, including files and long-running operations. Deployment values and external accounts are unconfigured.

## Evidence limits and completion

Current upstream tests use synthetic local/mock data. Actual-browser tests simulate the gateway. Package verifiers establish package consistency only. None proves real Immich effects, deployed Cloudflare OAuth routing or ChatGPT connectivity.

Specification chapter 18's acceptance matrix and every chapter 20 completion condition remain required. Keep implementation gaps, missing environment conditions, observed refusals and verified real successes separate. The full objective is not complete on the basis of local regression checks.

## Latest implementation evidence

- Ordinary JSON now uses pinned stream-json 3.8.0 with fatal UTF-8 decoding, backpressure, a depth limit and configurable bounded scalar/union assembly. Container pages are encrypted before publication. Every declared JSON success schema is compared against the complete sanitized projection in tests.
- Arrays larger than 1 MiB, nested arrays, Unicode, false/zero/null, union variants, unknown metadata, secret pointers, malformed/duplicate records, scalar/depth limits and actual SQLite close/reopen are verified. Failed/incomplete displays stay explicitly incomplete in result reads.
- OpenAPI boolean exclusiveMinimum/exclusiveMaximum are converted to numeric JSON Schema bounds.
- Version readiness validates the pinned official response schema and rejects prerelease builds; invalid version responses remain distinct from proven version mismatches.
- Startup/periodic cleanup removes expired records and original objects, display indexes, unused credentials and old generated orphan files. It skips active captures/readers/jobs, preserves unrelated filesystem entries and retains failed deletions for retry. Reader filesystem errors propagate without unhandled stream errors.
- A real running-job test confirms cleanup does not reinterpret live work. Jobs persist result receipts instead of duplicate display bodies; polling cannot bypass result TTL.
- Configuration tests verify durable DB paths, safe numeric limits, TTLs, queue limits and readiness failure/recovery after actual object deletion failures.
- Shared quotas account encrypted payloads, raw-file bytes and remaining reservations atomically per principal and globally. Upload chunk/assembly reservations are transferred, accepted jobs reserve terminal status space and executions reserve response metadata before sending. Failed deletion does not create free capacity.
- Tests independently sum SQL ciphertext lengths, physical object sizes and remaining reservations. They cover per-user/global pressure, rollback, failed captures/deletions, upload retry/assembly, quota exhaustion before/after send, a killed writer, legacy pending uploads/jobs and actual SQLite reopen.
- Seven storage-identity cases verify sequential database mismatch rejection, unrelated initialized databases, clean DB relocation, pre-identity migration, interrupted owner binding and repeated rejection of fresh databases over unknown existing files. Directory locking also prevents concurrent different databases sharing one objects root.
- Logical quota totals exclude database/index/WAL and filesystem overhead. Configured volume space must provide headroom beyond the logical limits. Deployment readiness/acceptance and live external integration remain unfinished.

- Original downloads now label complete, incomplete and legacy-unknown transfer status in the control UI, filename and response headers. Tests verify exact partial bytes/hash/length, no raw canary exposure in HTML, unknown legacy status and cross-principal rejection.

## Integrated outbound transport and encoded originals

- src/upstream.ts uses pinned undici 8.12.4 with fixed origin/base path, TLS verification, idempotent retries disabled and manual redirects. The pool preserves received encoded bytes. MAX_UPSTREAM_CONCURRENCY, UPSTREAM_CONNECT_TIMEOUT_MS and UPSTREAM_IDLE_TIMEOUT_MS are wired through validated configuration.
- The FIFO permit remains held until result inspection and terminal persistence finish. Capacity waits are cancellable and bounded; credential revision, context generation and input references are checked again at actual dispatch. A cancelled waiting job stays unsent; OAuth callbacks are consumed only there.
- Confirmed connection failures are distinguished from uncertain transmission. TLS record errors can occur after sending and require actual connection-failure evidence before being labelled unsent. Messages contain no upstream error details. No operation is automatically replayed.
- Original ciphertext is flushed before metadata commit. Projection then reads the original without buffering the whole body. src/content-encoding.ts handles gzip/x-gzip, deflate, Brotli and Zstd; each decoding stage and final inspected output is bounded. At most four coding layers are accepted; Zstd windows are limited to 8 MiB. Unknown coding, invalid trailers, malformed content, excessive expansion and interrupted transfers retain originals with explicit failures or uncertainty.
- Small registration/owner/version probes bound both wire and decoded bytes. Session results are decoded under a separate 64 KiB bound before explicit owner verification. Known secrets remain references in model-facing JSON/JSONL.
- Pipeline completion is awaited, including trailer validation. Cancelling a partially consumed Web Stream directly cancels its reader instead of waiting for another chunk. Tests cover this with an input that remains open.
- The control UI labels encoded originals and delivers exact wire bytes with .encoded filenames and x-immich-original-content-encoding, without automatic HTTP decoding. Complete/incomplete/legacy-unknown status and received hashes remain separate.
- Shutdown stops new executions, aborts owned HTTP traffic, waits for encrypted capture/projection persistence and then closes the vault. Incoming partial HTTP bodies are destroyed when cancellation occurs. A deferred local-capacity wait during version probing keeps the previous check and timestamp rather than fabricating an upstream outage.
- Real-socket tests cover compressed secret results and JSONL, encoded session import, invalid/unknown/oversized decoding, waiting-key changes, expired secret references, context revocation, unsent job cancellation, active-capture shutdown, shared application limits and deferred version checks. Existing native MCP and browser workflows remain required in the final regression.
- Primary implementation references: [pinned Undici client options](https://github.com/nodejs/undici/blob/v8.12.4/docs/docs/api/Client.md) and [Node 24.22.1 streaming content encodings](https://github.com/nodejs/node/blob/v24.22.1/doc/api/zlib.md).

- Final generated registry and operation coverage retain 279 operations with empty missing/unexpected/duplicate sets. Original inventory and package-consistency verifiers also pass. These remain local/mock acceptance evidence; real Immich and live Cloudflare/ChatGPT are unverified.

## Versioned encryption and offline master-key rotation

- src/vault-crypto.ts and src/vault-schema.ts implement version-bound AEAD, strict supported schema checks and transactional legacy metadata migration. Record key versions are stored explicitly; original metadata identifies format/version. Wrong keys or corrupt late records fail without partial migration.
- src/vault-rekey.ts creates an exclusively owned separate generation, reencrypts all retained records and originals, verifies plaintext integrity, assigns a fresh storage identity and publishes only after an authenticated manifest verifies. Existing destination directories are never overwritten. Incomplete/backup-only roots cannot start as an application.
- src/vault-manifest.ts authenticates file inventory and SQL state with a separately derived HMAC key. scripts/vault.ts provides offline rekey/verify without Cloudflare configuration or secret values on command lines/output. Verification can run without the old key file.
- Seven migration cases and seven rekey cases pass, including a real killed child process during encrypted output. Source ciphertext and readability remain intact; an incomplete target is rejected even after removing its process-crash marker because its owner/database identity does not match.
- OPS and master-key migration details are in OPERATIONS.md. The earlier complete generate/build/regression run passed 439 tests, followed by the missing-owner safeguard. The current results and remaining backup/deployment limitations are recorded below.

- Unbound directories, including loss of only the owner identity while the authenticated DB identity survives, require a unique authenticated raw record for every generated original before binding. Unknown originals remain untouched and no identity is minted on a failed retry.


## Authenticated offline backup and conservative restore

- src/vault-backup.ts and scripts/vault.ts implement backup/restore in addition to rekey/verify. The source is opened read-only with a consistent SQLite read transaction and storage ownership. Schema-1 backups do not migrate or rewrite the source. A committed WAL left by a killed process is included while the source main file and WAL remain unchanged.
- Backups include the separately configured source database, owner database, all retained encrypted metadata and generated original files. Missing/corrupt referenced originals fail before destination creation. Unreferenced generated ciphertext is preserved and counted, including an unbound source root; unrelated files and separately kept keys are excluded.
- An independent archive storage identity is established before copying the main database. An encrypted backup-only role and backup ID commit before original copying. Normal application/rekey startup rejects the archive even if its filesystem marker is removed. Partial candidates stay incomplete.
- Restore verifies the HMAC and inventory before creation and hashes every copied file. The archive is not mutated. Case-colliding/traversal paths, wrong keys/upstreams and nonempty SQLite WAL/journal files in archives are rejected.
- All queued/running/cancel-requested snapshot jobs are quarantined as outcome_unknown, even if their snapshot marker says unsent: work may have executed after that snapshot. The old marker is retained as diagnostic evidence, not a guarantee about subsequent effects. A started queue performs zero old HTTP operations in the restore test.
- Context generations advance and contexts are disabled; active secrets, cookies and OAuth state are cleared. Callbacks are marked used and their state index is emptied. This commits atomically with the new store identity and removal of the backup role. Regular API-key bindings remain subject to live upstream validation. The control UI explains recovery.
- Original references, expiries and resumable upload chunks are preserved. A restored in-progress upload accepts a duplicate acknowledged chunk, resumes and returns the exact original bytes. Source schema/ciphertext, immutable archives, other principals and partial/empty originals are checked.
- Fourteen new backup/boundary/process-death cases pass in the complete pnpm check run: 453 tests, zero failures/cancellations/skips, including all 279 core wire checks and the actual Edge workflow. The additional killed-source WAL case passes independently, and the current build includes it.
- Copy interruption is tested with actual killed child processes for both backup and restore; source files remain readable and incomplete targets reject startup even after markers are removed. This does not prove OS/power-loss/container-volume durability.
- OPERATIONS.md provides exact commands, separate-key recovery, activation settings and a snapshot rollback procedure that does not replay old work. The complete readiness/deployment contract and real Immich/Cloudflare/ChatGPT acceptance remain open. Explicit backup retention is now implemented as described below.


## Signed backup retention and interrupted deletion recovery

- src/vault-retention.ts adds separately authenticated retention plans, an OS-backed collection lock, strict owned-file inventories and explicit apply. The CLI saves a new plan outside the backup collection without overwriting an existing file. It requires a separately stored key and fixed upstream, without Cloudflare configuration.
- The newest N eligible, independently identified backups are retained. Keep is 1–1000 and collection enumeration is bounded. Other keys/upstreams, duplicate backup IDs, case-colliding archive names, future dates, unfinished/non-backup generations and archives containing extra files are preserved and reported.
- Apply verifies the whole approved set before any rename/unlink, binds the physical root/archive identities and rechecks retained archives during deletion. Replacement directories with identical signed files do not satisfy the old plan. A changed or missing retained backup stops the run.
- Approved archives move to deterministic private deletion directories. A flushed, authenticated intent authorizes only the known files. Their remaining hashes and directory boundaries are checked before unlink; there is no recursive deletion. Extra files and tampered plans/intents are preserved/refused. The final intent is reauthenticated before removal.
- Reapplying the same plan resumes a moved or partially removed archive; already removed entries are separate from newly deleted entries. Actual killed child processes exercise interruption after rename and after the first unlink, exclusive-lock rejection while live, stale/tampered intent refusal and preservation of an added operator note.
- New immutable archives use standalone SQLite DELETE-journal main files. Read-only inspection then leaves no unsigned WAL/SHM files. Archives with extra auxiliary files remain restorable but are conservatively skipped by retention. Failed normal startup authenticates the key/role before journal-format changes, preserving the backup's signed main-file hash.
- All eight retention cases pass in the complete pnpm check run: generation, build and 462 tests, zero failures/cancellations/skips. This includes all 279 core HTTP-wire cases, the actual Edge workflow, backup/restore/rekey, legacy migration and storage identity. Testing used only generated temporary backups; no production retention run was performed.
- OPERATIONS.md records plan/apply commands, per-key policy, skipped-entry handling and exact interruption recovery. Large real collections, OS/power-loss behavior and container-volume durability remain unverified.


## Runtime integrity, operational readiness and container artifacts

- scripts/generate.ts now fingerprints the generated registry, normalized loaded registry value, browser upload script, MCP tool contracts and sync mapping. src/runtime-integrity.ts also checks the pinned original OpenAPI hash and all 279 operation triples. Missing/mismatched runtime assets reject startup before data creation.
- TypeScript reformats imported JSON by default, changing the fixed API's bytes. scripts/copy-assets.ts now restores the exact six required assets after compilation and verifies the built bundle. A separate copied dist bundle, with no source tree, boots and serves readiness successfully.
- src/vault.ts health checks use a rolled-back write probe and required capacity ledger, current schema/crypto headers, authenticated key check and authenticated owner identity/version. Checks preserve encrypted records and exact quota totals. src/readiness.ts adds configured key-file matching, a flushed nonsecret storage probe and asset integrity.
- Configuration canonicalizes existing path aliases and prospective data paths, rejects master keys inside the actual data root and records the resolved external key file. Missing/changed keys, query-only DBs, missing ledger rows, unsupported headers, corrupted key checks, owner mismatch and unavailable storage are detected; successful rechecks recover readiness.
- Application checks local readiness at startup/every 30 seconds and shares a cached/in-flight check for endpoint requests. Public output contains statuses and a timestamp without keys, key/store versions, principals, paths or internal URLs. New API execution and control-UI POST changes are blocked after a detected local/cleanup failure; failed work is not automatically replayed.
- Dockerfile uses separate production dependencies/build/runtime stages, preserves original bytes, runs UID/GID 1000 and includes only runtime assets plus provenance/license. The frozen package manager is pnpm 11.25.0. The selected Node image is 24.22.2 bookworm-slim, while current local Node is 24.22.1.
- compose.yaml has no published port, uses read-only roots, drops capabilities, sets no-new-privileges, binds only dedicated data, mounts the two secrets separately and gives cloudflared no Immich network access. Dedicated egress routes permit JWKS/attachment/Cloudflare traffic. The selected cloudflared release is 2026.10.7; image availability/digests are not verified.
- scripts/healthcheck.ts uses bounded localhost responses. Native HTTP tests run that actual built CLI, verify ready/live success and show that upstream outage fails readiness while liveness stays healthy. This is host execution, not a Docker run.
- Six readiness/bundle cases and three deployment/health/key-path cases pass in the complete pnpm check run: generation, exact-asset build and 471 tests, zero failures/cancellations/skips, including all 279 core wire checks and actual Edge.
- DEPLOYMENT.md and deploy/.env.example record fixed official source references, image digest review, private environment paths, UID/file permissions, routing, health, update/recovery and remaining gates. Direct registry metadata lookup did not complete and was cancelled; Docker/Compose is not installed. No image build, Linux mount, live cloudflared, real Immich or Cloudflare/ChatGPT success is claimed.


## API-key self-rotation receipts and job recovery

- Vault.replaceBinding can atomically persist the new active secret, verified result binding and a terminal job receipt. Executor stores an uncertain display first, then commits the proven self-rotation together; failed transaction writes roll back all three. A later duplicate receipt-store failure cannot downgrade the committed completion.
- Jobs.get authorizes only that rotation's exact next binding using its encrypted transition proof, UUID key identity, accepted revision, request/operation/result IDs and original context provenance. Ordinary old results remain invalid, as do receipts after a later registration/disconnect. Result TTL and cross-principal restrictions still apply.
- An explicitly consented general-session rotation transfers its receipt to the same normal API-key binding. The old context remains paused. Other context results do not gain this exception, and ordinary requests never automatically switch authentication.
- Rotated ID and secret are extracted from the validated persisted JSON projection, so a response beyond the inline limit, including a large compressed name payload, can still update the binding without buffering the complete decoded body. Plain secrets remain absent from model-facing results and remain encrypted at rest.
- Failed or mismatched local adoption retains outcome_unknown/rotation_recovery_required in both job/result views. Concurrent binding replacement or a different response ID cannot be overwritten. The protected original remains available within its binding/context/TTL boundary for explicit recovery; OPERATIONS.md describes the procedure.
- Actual killed child processes stop inside the uncommitted transition and immediately after commitment. Reopening SQLite yields the old key with uncertain recovery data, or the new key with its completed result/job. Neither state replays the upstream call; retained originals remain encrypted and readable by their owner.
- API-key UUID comparisons handle hexadecimal case differences in self-rotation, self-delete and session owner verification. Secret tokens and opaque references remain exact strings. Tests also reject a different candidate session owner.
- A reproduced crash-recovery diagnostic issue is fixed: a recovered unsent job's final receipt clears the prior attempt's stale error. Its successful result now reports success without the old failure message.
- Thirteen rotation/identity/forced-exit cases plus the additional recovered-diagnostic case pass. The complete pnpm check run passes generation, exact-asset build and 485 tests with zero failures/cancellations/skips, including all 279 core wire operations and the actual Edge workflow.
- These are synthetic local/runtime recovery tests. Actual Docker/Immich/Cloudflare/ChatGPT acceptance remains open. The fixed upstream Docker Compose source has been inspected for the next isolated integration setup; no real integration success is claimed.

## Isolated backend infrastructure preparation

- Added src/integration-lab.ts, scripts/integration.ts and pnpm integration prepare/up/check/down. INTEGRATION.md describes the executable commands and their limits. This does not replace the remaining real 41-category integration work.
- Preparation refuses an existing run directory or one inside the checkout. It creates new private owner/config files and a UUID-derived Compose project. A signed manifest binds the fixed source/OpenAPI, configuration hashes and physical directory identity.
- The four-service Immich 3.3.5 stack uses separate named volumes and project-specific networks, with only the server published on loopback. Dependencies/image references are traced to the fixed source Compose file. Application image digests/pulls still need real-host verification.
- A command resolves and pins one local Docker socket, checks the Linux engine identity, holds an OS-backed SQLite owner lock and validates current resource ownership before start or teardown. Bind mounts, unexpected image references/networks/ports and bind-backed volume options fail closed.
- Default teardown keeps volumes. Explicit volume deletion records durable intent, prevents restart and can be resumed. Repeated teardown rechecks a previously destroyed run, allowing explicit cleanup of late owned resources from a disconnected Compose client. Host private files are retained.
- Tests use a Docker command harness and synthetic version replies, always marked harness_only. Actual subprocesses verify CLI behavior and exclusive ownership. A healthy real backend observation would still report api_integration_completed=false and full_acceptance=false.
- pnpm check passed generation, exact-asset build and 514 tests, zero failures/cancellations/skips (214092.9843 ms). The 29 added tests cover preparation, manifest/config/path tampering, daemon changes, resource boundaries, readiness, restart, interrupted/late cleanup, socket selection and real CLI/lock behavior.
- No real Docker, Immich account bootstrap, API integration, Cloudflare or ChatGPT execution occurred. The next implementation phase must create encrypted synthetic fixtures and the actual category/special-adapter integration runner. The Docker environment choice remains unanswered.

## Synthetic account/key bootstrap (2026-11-10)

- Added src/integration-bootstrap.ts and pnpm integration bootstrap --directory ABSOLUTE_RUN. The callable command requires an authenticated, active, owned four-service laboratory and a fresh getServerConfig.isInitialized=false backend.
- The running-lab callback keeps the exclusive OS-backed run lock through setup. Default HTTP uses the direct fixed-origin upstream pool, not environment proxy routing. Injected adapters permanently mark signed run provenance harness_only; encrypted setup evidence cannot be promoted to real integration.
- Public signup/login use the existing explicit public context/common executor, protected password references, schema validation and encrypted originals/secret projections. Creating general users uses only the new admin API key. Initial key creation is a separate explicit owner-session setup operation, never a fallback after key refusal.
- The setup creates one synthetic administrator and general users A/B, random passwords and example.invalid addresses, with notifications and first-login changes disabled. It registers admin/all, A/all, B/all and an A-owned key with only asset.read using getMyApiKey. The restricted principal receives no saved password/session, and no user.read/apiKey.read is added.
- The separate original .vault.key protects fixtures/, including synthetic credentials, native key-response bytes, protected inputs and durable step receipts. Started/sent state precedes backend mutation. Unknown responses, failed persistence/projection and actual process death prevent repeated partial initialization; operators explicitly discard the disposable stack rather than replaying account/key creation.
- Completed setup only revalidates the same original key IDs and recorded owners, preserving binding revisions. It records the latest read-only credential check, affected role/status and time separately from historical setup completion. Another fixture owner's valid replacement key is rejected.
- The caller-identity regression was reproduced before the fix: revalidation accepted A rebound to B's valid key. It now compares the original encrypted key/owner record before the live probe. The added regression passes without account/key recreation or session fallback.
- bootstrap-report.json contains 279 operation triples, 41 category entries and sanitized setup observations, with all feature integration statuses not_run and full_acceptance=false. Credentials, secret references, payloads and email addresses are excluded.
- New tests model user/auth/key endpoints with pinned schemas, inspect header isolation and all four key permissions, scan persisted data/reports for generated plaintext secrets, test freshness and wrong owner/permissions, revoke/replace bindings, change/remove the master key, hold a competing run lock, and kill an actual setup process after its sent receipt. tests/lab-harness.ts and tests/bootstrap-harness.ts supply shared synthetic adapters.
- pnpm check passed generation, six exact runtime assets, TypeScript and 527 tests, zero failures/cancellations/skips, duration 287114.5295 ms. This adds 13 bootstrap regressions to the previous 514-test baseline. The 279 core-wire operation report still has no missing/unexpected/duplicate triples.
- No real Docker/Immich account setup or API effects were executed. Real 41-category feature tests, special workflows, Linux/container operational gates, Cloudflare and ChatGPT remain required. The Docker environment choice remains unanswered.

## Synthetic media fixture scenarios (2026-11-10)

- Added pnpm integration fixtures, src/integration-media.ts, src/integration-run.ts and src/integration-fixtures.ts. withInitializedFixtureLab revalidates the original four caller key IDs/owners and retains run/store ownership through the phase. Staging and the production Control resolver enforce caller ownership and binding revisions.
- Three deterministic 64x32 PNGs represent A's sharing candidate, A's separate private image and B's private image; A's sharing candidate includes XMP. Unicode filenames, creation/modification timestamps and favorite false/true are sent through the common multipart serializer/executor. No database/photo directory access or mounts are added.
- The initial 42 named cases check new201/intentional duplicate200, caller identities/non-admin status, own-key listing, exact version, asset owner/ID/SHA1/name/favorite, original bytes/SHA256, album membership/counts, before/after sharing, separate private-image isolation, exact400 ownership and403 permission refusals, and tag assignment/isolation.
- Cases cannot pass from HTTP status alone: their required named semantic assertions must be evaluated. Per-item success=false under HTTP200 fails. Evidence reports list all279 triples/all41 tags but only six categories currently have representative cases: Server, Users, API keys, Assets, Albums and Tags. Other category/scenario work remains required.
- Completed fixture reruns execute only26 originally passed non-mutating cases, matching actors, operation inputs, exact statuses and assertion-name sets. Missing/replaced requests and disguised mutations fail before send. Historical setup completion and a new read-only validation result are recorded separately.
- Original request/result refs, input envelopes and local dataset handles stay in the encrypted feature journal. Public media_fixtures_v1.report.json contains only case/status/assertion/time metadata. Harness runs record zero real-success/refusal counts and never claim full API/category/Cloudflare/ChatGPT acceptance.
- Actual TCP HTTP tests use the default managed client against an independent synthetic user/asset/album/tag model, parsing multipart and checking bytes. An actual browser decodes the generated PNG and parses XMP. Lost acknowledgements, actual process death after sent state, failed bulk items, absent share effects, corrupt original bytes and replay guards are tested. The real Immich backend was not used.
- Native default transport testing exposed the version probe's redirect:error incompatibility with the managed client. The probe now uses manual mode and rejects non200 directly; a native redirect test proves no target request is made.
- Fixed-source inspection corrected caller-specific favorite expectations and the sidecar filename condition: a viewer sees favorite=false, and the sidecar upload omits the optional global filename override so its own .xmp extension is checked. Other photo cases retain the explicit filename field. The fixed upload conversion handles UTF8 original filenames. Source links are in INTEGRATION.md.
- Report-failure regressions reproduced completed account/feature evidence being downgraded to recovery_required after only publication failed. Completion is now explicitly committed before publishing and retained on publication failure. A completed journal is closed to extra requests. Retrying a completed command only revalidates reads, with fixture_report_failed distinguishing the filesystem artifact failure. Assertion-name comparison is order-independent.
- Two intermediate537-test full runs failed the native bootstrap freshness read before any account mutation (536pass/1fail): outcome_unknown, no HTTP status, upstream_transport_interrupted; the synthetic HTTP server reported no handler error. Focused native runs passed. Provisioning now uses nonpersistent HTTP connections across local crypto/storage work; normal application transport remains pooled by default. Regression tests verify two exact requests/two close connections across an idle interval, ordinary reuse, invalid settings, and close headers throughout the native provisioning flow. No retry or credential fallback was added.
- The media-phase pnpm check passed registry generation, six exact runtime assets, TypeScript and all539 tests, zero failures/cancellations/skips, duration395570.6645 ms, under the same default full-suite concurrency. The279 core-wire operation report still has empty missing/unexpected/duplicate sets.
- This is local/native-harness evidence, not actual Docker/Immich effects. Short video, PIN/shared-link contexts, HLS/sync/OAuth/maintenance and the rest of the41-category feature cases, real containers/Linux operational durability, Cloudflare and ChatGPT remain incomplete. Docker and ffmpeg are absent from the current development environment; the Docker environment choice remains unanswered.

## Schema validation cache and resource audit (2026-11-10)

The original validator converted and compiled a fresh schema into one long-lived Ajv for every call. An isolated generated-data probe confirmed retention after explicit GC: 600 equivalent validations left 600 extra entries in Ajv's strong schema map, and heapUsed grew from 5,516,384 to 17,460,776 bytes. The installed pinned Ajv also retains schema/code-generation references outside that map; removeSchema alone would not release those references.

src/schema.ts now uses a content-matched LRU with limits of 256 entries and 8,388,608 UTF-8 serialized schema bytes. Conversion includes only reachable component definitions. The full converted JSON content is checked each time, so mutations of root or referenced schemas cause a new compilation. Cached schemas are detached snapshots, including large enum arrays. Each compilation uses a separate Ajv instance and scope with the original validation options and formats; no global compiler accumulates discarded definitions. Oversized and non-JSON definitions remain executable through fresh, uncached compilers.

The byte budget counts serialized schema content. Generated code, object overhead, transient compilation and functions retained by callers are outside that counter; this does not cap total process memory or complete all long-running resource acceptance.

Observed standalone Node 24.22.1 results, after explicit GC:

| Generated workload | Original heapUsed bytes | Updated heapUsed bytes | Updated cached entries |
| --- | ---: | ---: | ---: |
| Baseline | 5,516,384 | 5,384,296 | 0 |
| Same schema, 600 calls | 17,460,776 | 6,109,768 | 1 |
| Followed by 300 distinct schemas | 22,713,608 | 8,772,352 | 256 |
| Followed by 1,200 distinct schemas total | Not measured | 8,549,936 | 256 |

Baseline-relative growth for the repeated 600 calls was 11,944,392 bytes before and 725,472 after. At 1,200 distinct schemas the new cache had evicted 945 entries and retained 97,992 serialized bytes. This is one local generated-data sample, not a production heap guarantee or a performance gate. The first 600 repeated calls took 608 ms before versus 31 ms after. The first 300 distinct-schema calls took 292 ms before versus 953 ms after: isolated compilation costs more on misses, while repeated schemas reuse their function.

Reproduce the updated measurement after building:

~~~sh
pnpm build
node --expose-gc dist/scripts/schema-resources.js
~~~

reports/schema-validation-resources.json preserves both observed datasets, conditions, source fingerprints, limits and the acceptance scope. The script generates synthetic objects only and sends no upstream requests.

Seven new regression tests cover equivalent fresh schemas, no coercion/default insertion/input mutation, mutable roots/references and enum snapshot isolation, recursion/nullability/formats/unions/exclusive bounds, LRU and byte eviction with held validators, failed compilation/reference isolation, uncached non-JSON/oversized definitions, safe limits and repeated production request serialization.

The schema-cache phase pnpm check passed deterministic generation, six exact runtime assets, TypeScript and all 546 tests with zero failures, cancellations or skips (duration 376579.5862 ms). All 279 core HTTP wire tests pass; missing/unexpected/duplicate remain empty. Actual browser, native HTTP, process-death, isolation, secret projection and operational regression cases remain included.

This fixes one confirmed retention path. Docker, Podman and nerdctl are unavailable on this host; wsl --list --verbose also reports that WSL is not installed. Real Immich/container/Linux durability, the remaining category/special-workflow scenarios, Cloudflare and ChatGPT acceptance remain unfinished. No production endpoint or data was used.

## Explicit authentication fixture scenarios (2026-11-10)

src/integration-auth-fixtures.ts and pnpm integration auth-fixtures add a separate
durable plan, auth_contexts_v1, after the existing account/key bootstrap. It uses
three separate deterministic images (ordinary A, locked A, private B), random A
PIN/link passwords, original synthetic owner sessions and two protected A-owned
links explicitly connected to B. It does not reuse or alter the earlier media
plan's images/albums/tags.

The first run passes 60 named cases: 56 executor HTTP cases and four local
pre-dispatch refusals. Completed repeats run 17 previously passed non-mutating
cases (16 executor HTTP cases and one local refusal), plus the existing separate
backend/original-key preflight reads. There is no repeated upload, PIN
configuration/elevation/relock, link login/rotation/expiration, or context creation
and mode change.

PIN cases verify special-mode defaults and consent, separate current session IDs,
API-key-only unlock refusal, wrong PIN, explicit session elevation, general-mode
selection, exact locked-original bytes, isolation from other owners and the
restricted key, and explicit relocking. The final fixture deliberately leaves A's
PIN configured and the dedicated image locked. General-session mode is explicitly
selected only for the synthetic A/B contexts; ordinary bindings remain API-key
calls and the restricted principal has no session.

Shared-link cases verify key/slug authentication, exact link membership, owner,
download flags, separate password cookies, incorrect password, rotation
invalidating old cookies, successful new-password login, expiry for both key and
slug, and a separate still-readable download-disabled link. All non-null request
slugs, passwords and PINs use declared operation/context-bound protected
references. Reports omit credential values, inputs, context IDs, result refs and
response bodies. Contexts expire within 24 hours; completed revalidation never
relogs in or renews them.

The common IntegrationRun now accepts an explicit context reference/generation,
uses production Contexts and Control.resolver, pins the route during completed
revalidation, and separates local_refusal from actual upstream refusals. A local
refusal must occur before beforeSend, have no HTTP status and match its expected
BridgeError code. Dispatch followed by failure cannot become a local pass.
Public per-operation counts distinguish local and upstream refusals and preserve
zero real counts for injected harnesses. Known 302/307 transport corrections are
accepted with exact status assertions and private encrypted Location retention.

Seven new regression tests include the full account-bootstrap/authentication flow
over native HTTP, actual multipart decoding and original-byte checks, exactly one
upstream credential per request, closed provisioning connections, encoded
password-cookie values and multiple Set-Cookie headers, 60/17 case counts, file and
public-report plaintext scans, and a later read-only validation failure retaining
historical completion. Fault injection covers a lost unlock response, schema-valid
204 without elevation, and acceptance of another context's password cookie.
Additional checks pin route/generation, reject cross-principal/normal-route/stale
secret references and inline PINs before dispatch, and verify redirect secrecy.

The authentication-phase pnpm check passed generation, TypeScript, six exact runtime assets and all
553 tests with zero failures, cancellations or skips, duration 383209.6605 ms.
The native authentication pipeline completed in 200972.8966 ms in this full run.
The all-operation core wire report still has 279 passes and empty
missing/unexpected/duplicate sets. No actual Immich server or production data was
used by those HTTP harness tests.

This plan represents 13 operations under Assets, Authentication, Sessions and
Shared links. Together with media fixtures, named cases span nine primary tags.
This is not completed nine-category acceptance: every full-category/41-category
and real-integration gate remains open until its required scenarios are executed
against isolated real Immich. Short video, remaining categories, HLS, sync, OAuth
and maintenance scenarios still need expansion and real execution.

## Public Immich image-index observation (2026-11-10)

Separately from local tests, anonymous HTTPS reads of the official GHCR v3.3.5
server and machine-learning OCI indices succeeded. SHA-256 of the received index
bytes matched each Docker-Content-Digest header. Both publisher annotations name
8303cb117e197c700332b33b61b45314c9cc5bb4, and both list Linux amd64/arm64 descriptors.
reports/immich-image-manifests.json records the observed index/child descriptors
and the exact scope. This is metadata and publisher annotation evidence only:
child manifests/configs/layers, image signatures and actual containers were not
verified or executed.

At the initial index-observation phase, new-run digest pinning still required
existing-run checks/teardown compatibility and references still used v3.3.5 tags. Actual Docker/WSL installation or an available test host, pulls,
container/Linux operational acceptance, complete 41-category API effects,
Cloudflare and ChatGPT remain outstanding.

## Isolated-run image pinning and v1 compatibility (2026-11-10)

New prepareLab runs now create authenticated payload version 2 and select four
digest references. The server/ML images use the previously observed official
v3.3.5 OCI indices; Postgres and Valkey retain the fixed source Compose digests.
Existing authenticated payload-v1 runs retain exactly their original app tags
and dependency digests through start, check, default stop, restart and explicit
volume deletion. The envelope/key/HMAC protocol remains unchanged, and no
automatic configuration, key, namespace or data migration is performed.

up/check now compare both authenticated file hashes and the parsed full selected
Compose template, plus the generated DB_PASSWORD dotenv format, before any Docker
invocation. This prevents a changed config or authenticated version reinterpretation
from reaching container creation. Teardown continues to use signed version/
physical ownership/resource checks without requiring Compose or env files.
Cross-policy container image substitution and unsupported/missing payload versions
are refused. Observations distinguish configured digest pins from actual image
content/runtime verification.

The frozen pre-change v1 Compose fixture is tests/lab-compose-v1.fixture.json,
captured from the original built implementation before edits, SHA-256
0d3743c99ba8871e56dd2b9cff96c81607cdf7bc5321c57a2990c1abff8bfa77.
Test-only helpers reconstruct its original authenticated runs. Twenty new test
cases (including nested cases) verify the recorded official app index references,
v2 envelope/policy metadata, original v1 lifecycle without config files or key
rewrites, both directions of cross-policy image substitution, an authenticated
version downgrade, canonical image/bind/database/port/command/env drift under both
versions, and unsupported/missing versions. The targeted policy/lab set passed
all 49 tests.

Latest pnpm check passed generation, TypeScript, six exact runtime assets and all
573 tests with zero failures/cancellations/skips, duration 361767.2364 ms. The core
wire report still has 279 passes and empty missing/unexpected/duplicate sets.
Native HTTP authentication/media, protected references, browser and operational
regressions remain included. These local Docker-harness checks do not prove
actual image pulls or container/Linux durability.

A separate public-registry follow-up verifies metadata by immutable digest,
including received index bytes, Linux amd64/arm64 child manifests and image config
JSONs. Server and ML metadata hashes match all referenced digests and their config
labels name the fixed source commit on both architectures. Postgres child/config hashes were also verified on both architectures. All four
fixed index digests were confirmed. The Valkey platform-metadata lookup returned
HTTP 401, and a same-public-scope anonymous-token retry exceeded its 60-second
process deadline; that gap remains unverified. The metadata attempts are terminal,
and reports/immich-image-manifests.json records three verified platform pairs and
the remaining gap. Filesystem layers and image signatures are not verified, and
no container is executed by these metadata reads.

Current host inspection still finds no Docker/Podman executable and wsl --list
--verbose reports WSL uninstalled. Actual Docker pulls/Compose/platform execution,
Linux operational acceptance, remaining category/special-workflow scenarios,
Cloudflare and ChatGPT remain outstanding.

## Short video, Range, HLS and empty configuration secrets (2026-11-10)

Added the independent video_fixtures_v1 plan and pnpm integration video-fixtures
command. It uses a frozen programmatic H.264 MP4 (320 x 180, 3.936867 seconds,
4754 encoded bytes), with an inert per-run/per-role free box for unique checksums.
The developer generator records browser/dimensions/decoded color pixels/MP4 boxes
and SHA-256, refuses to overwrite a destination, and has a bounded browser lifetime.
Real-browser tests decode both the unique original and init-plus-fixture-fragments.
No real camera, screen, external media or audio is used.

The initial plan temporarily configures ordinary admin-key HLS settings (integer
480, h264) and disables background playback conversion, then uploads A/B videos.
It checks known asset/checksum/owner and bounded metadata readiness, exact original
bytes/hash, original Range, stable original-backed playback, byte/suffix ranges,
out-of-range behavior and ownership/scope refusals. HLS checks include fixed
master/VOD references, init and every fragment, both dedicated headers and an
end acknowledgement. All HLS GETs and end calls are marked mutating, so neither
completed revalidation nor a lost response can replay them. End acknowledgement
does not claim worker cleanup or successful decoding of real server output.

Successful completion requires exact original admin configuration restoration.
Config inputs protect nested OAuth and SMTP fields, including empty strings.
The private journal retains originals/config snapshots/baselines/session IDs;
public reports omit inputs, credentials and result/context references.
The usual immediately-ready fixture has 40 initial cases and 20 non-mutating
revalidation cases; polls can add initial observations. It represents ten
operations under Assets and Config (admin), without completing category acceptance.

Source inspection found original-download Range absent from the earlier input
corrections. contracts/transport-overrides.v3.3.5.json supplements the generated
registry without changing the attached OpenAPI/contract files. The supplement is
bound to the fixed version/commit/hash/triple and rejects duplicate facts and
requirements. Original and playback wire tests preserve received 206/416 bytes
and headers. The fixed Immich sendFile callback-error path forwards
NotFoundException while headers remain writable, so the video fixture expects
404 for its out-of-range request. This expected fixed-handler behavior is distinct
from preserving a received 416; actual Immich error behavior remains unverified.

The existing authenticated control UI already accepts an explicitly submitted
empty string, but HTML required prevented entering it through the browser.
Removed that attribute from the secret-value input and explained empty values.
The control regression submits empty OAuth/SMTP values with JWT/Origin/CSRF,
creates target-bound secret refs, resolves them into a complete updateAdminConfig
request and verifies exact outgoing empty strings. Its focused run passed.

Ten new regression cases (including nested fault cases) cover bounded MP4 framing,
confined playlist references, actual browser decoding, native HTTP, original/range
bytes, protected configuration/no-plaintext scans, read-only completed repeats,
a lost main-playlist acknowledgement, malformed HLS references, corrupt fragments,
an ineffective configuration restore, and nested empty-secret ownership/revision.
Independent fixture environments run with bounded concurrency. Tests use synthetic
HTTP/Docker models and never count their requests as real Immich success.

The first completed full run evaluated 583 tests: 581 passed and two existing
job-polling tests ended their fixed 100 x 10 ms wait while jobs were still running.
All ten video tests and all 279 core wire cases passed in that run. The report
retains that failure honestly in reports/video-phase-check-2026-11-10.json. Its
post-generation snapshot matches the test-phase end; its earlier comparison also
includes the expected regeneration of registry/integrity assets.

The two tests now observe their original job until a monotonic 30-second deadline,
return unexpected terminal states for the existing semantic assertions, and never
resubmit the operation. The complete sync-results/transport targeted set passed
eight tests, duration 28047.5863 ms. Test-file concurrency is bounded to four;
all 583 tests and production durability settings remain in scope.

The corrected pnpm check completed successfully: 583 tests, one suite, 583 passes,
zero failures/cancellations/skips, duration 1246808.649 ms. Generation still has
279 operations and empty missing/unexpected/duplicate sets. Seven runtime assets
are copied and build integrity passes. reports/video-phase-check-2026-11-10-r2.log
and its companion JSON retain the final output/counts and 125 selected source
hashes, which matched before and after execution and again at final inspection.
The refreshed operation report has all 279 core_wire_pass values true, with all
real integration still not_run.

reports/fixture-plan-coverage.json maps static operation_id literals in the three
feature-plan modules to 10 primary tags, with 31 other tags not referenced there.
It explicitly excludes bootstrap/adapters and is not a runtime scenario or
category-acceptance inventory. All 41 real-category/full-acceptance gates remain
open.

Fixed source URLs/hashes and the verification limits are in
reports/video-fixture-sources.json. Anonymous GitHub tree API discovery reported
a rate limit; fixed raw service-index/source reads succeeded. No registry retry,
Docker installation, production connection or external account changes were made.

Current host checks still find no Docker/Podman/nerdctl and WSL is uninstalled.
Real Immich/HLS effects, worker cleanup, Linux container/volume operations,
remaining category/special-workflow scenarios, Cloudflare and ChatGPT acceptance
remain unfinished. The goal is not complete.

## Explicit synchronization fixture plan (2026-11-10)

Added pnpm integration sync-fixtures and the independent sync_fixtures_v1 plan.
It creates three dedicated one-day child sessions (two for A, one for B), keeps
their default special purpose, and uses distinct synthetic sync_a/sync_b images.
The original parents are used for child creation without changing their sync
positions. Child creation, token protection and registration use the production
executor/Contexts owner checks; the restricted key receives no context.

The 72 named initial cases cover paged AuthUsersV2/AssetsV2 snapshots, complete
JSONL/secret-safe order, owner and same-user/different-session isolation, exact
ACK persistence, favorite deltas, per-type deletion/replay, invalid ACK types,
old-progress reset, explicit reset:true and pending-session reset. Eleven matching
non-mutating verification cases run on a completed repeat, with no stream or ACK
replay, child creation, upload or update. Original-key/backend and registration
preflight reads are separate from those counts.

The common IntegrationRun gained an optional internal complete_jsonl result view
only for successful getSyncStream. It requires a complete decoded projection and
terminal even when the preview is truncated. Other cases retain their strict
default. The selection is pinned in receipts/revalidation. The sync helper reads
every sanitized page and compares it to the private original, accounting only
for properly scoped PIN references. All stream calls are marked mutating; there
is no completed stream/reset replay.

The native HTTP test passed all 72 initial and 11 revalidation cases (duration
91281.9806 ms), including more than 16 records, actual multipart/file bytes,
chunked JSONL and final-state assertions. A subsequent set of nine tests passed
(duration 156390.5934 ms). It verifies lost-ACK no-replay, owner-scoped checkpoint
bugs, ineffective ACK writes, foreign rows, default/paged-view guards, missing
terminals and interruptions. Public reports and private fixture files are
scanned for plaintext keys, session tokens and PIN canaries.

The full pnpm check passed all 593 tests across two suites, with zero failures,
cancellations, skips or todos, duration 838862.1537 ms. The final output/counts
and 129 selected input hashes are in reports/sync-phase-check-2026-11-10.log and
its companion JSON. All selected inputs matched before/after execution and again
at final inspection. Generation/build retain 279 exact operations and seven
runtime assets. The fresh core wire report has 279 passes and empty
missing/unexpected/duplicate sets; real integration remains not_run.

This adds Sync to the four feature-plan modules' static references (eleven tags).
The source-literal inventory explicitly excludes bootstrap/adapters and does not
prove runtime/category coverage. Remaining sync entity/backfill scenarios, other
category plans and all real Immich/Linux/container/Cloudflare/ChatGPT acceptance
remain unfinished. No real server or user media was used. Fixed source URLs,
hashes and the scope are in reports/sync-fixture-sources.json.

## Memory and stack fixture expansion (2026-11-10)

Added the independent collection_fixtures_v1 plan and collection-fixtures command.
Six new image roles are distinct from all earlier feature plans. The usual
109-case initial run covers all eight Memories and seven Stacks operations,
with exact state readbacks and a separate restricted-key refusal per operation.
Completed repeats run 37 matching non-mutating cases. Bounded EXIF readiness can
raise the initial count to at most 223, below the journal's 256-case ceiling.

Source inspection pins filtered memory creation, per-item duplicate/no_permission/
not_found results, empty-memory search versus statistics, saved baseline counts,
primary-first stacks, merge inheritance, owner checks and SET NULL asset links
after stack deletion. The native harness uses real multipart and executor HTTP;
its synthetic models cannot count as real Immich success. Fault injection covers
lost merge responses, ineffective membership writes, missing inherited children,
partial bulk deletion, foreign memory search rows and ignored primary changes.
Public/private files are scanned for plaintext credential canaries.

The initial targeted run found invalid camel-case generated case IDs before
foreign mutation dispatch. It was intentionally stopped after two observed test
failures; the log and pre-fix hashes are retained in
reports/collection-targeted-check-2026-11-10-initial.json. Generated identifiers
now use the journal's accepted format. The response model also follows the fixed
withStack projection boundary. The revised build passes with seven runtime assets;
the r2 targeted regression set passed all eight tests with no failures, skips or
cancellations, duration 420989.9531 ms. Its 132 selected input hashes matched
before/after execution and again before the full run. The native 109/37 pipeline
passed in 357259.8988 ms. Final targeted evidence is in
reports/collection-targeted-check-2026-11-10-r2.log and its companion JSON.

The initial expanded pnpm check (601 tests expected) was intentionally stopped
before a dependency update. Its partial log and stop-time input hashes are in
reports/collection-phase-check-2026-11-10.log and the interrupted companion JSON;
no final pass/count is claimed. The dependency-update section below records the
reason and replacement verification. Generation retains 279 exact operations
and build passes with seven runtime assets. The earlier full 593-test sync-phase
result remains historical baseline evidence, not proof for new code.

The five source-plan modules statically reference thirteen tags. Every real
category/full-acceptance gate remains unverified; real execution and remaining
category/special-workflow scenarios remain required. Fixed source URLs/hashes
and inspection limits are in reports/collection-fixture-sources.json.

## Valkey platform metadata follow-up (2026-11-10)

A single bounded follow-up using curl and a new anonymous public pull token
completed the previous Valkey metadata gap. The fixed index body/header digest
and both Linux amd64/arm64 child manifest sizes/digests and config blob
sizes/digests were verified. Config architecture/OS match the descriptors. The
request budget was 55 seconds; eight HTTPS requests completed in 6.508 seconds.
Config redirects were limited to named registry/CDN hosts and cross-host
Authorization was removed. No token, signed redirect query, config environment
values or filesystem layer was persisted.

reports/valkey-platform-metadata-2026-11-10.json retains this new observation. All
four laboratory services now have verified index and amd64/arm64 metadata
observations across the reports. The earlier combined image report is also a
test input and was kept unchanged during the first full collection-phase run.
After that run was stopped for the dependency update, it was reconciled to the
new observation. Version 3 retains the prior HTTP 401 and timed-out retry under
previous_redis_attempts and marks only metadata verification complete. It is now
included in the replacement run's selected input hashes. Publisher labels remain
publisher claims. Filesystem layers, image signatures, actual pulls, containers,
Linux durability and API/external acceptance remain unverified.

## Ajv dependency advisory and patched pin (2026-11-10)

The production dependency audit found one moderate advisory,
[GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6),
in Ajv 8.17.1. The affected option was not enabled in the only runtime compiler;
this is a source/configuration assessment, not an exploit test or full security
audit. The project now pins 8.18.0, the
[official patched release](https://github.com/ajv-validator/ajv/releases/tag/v8.18.0),
and explicitly sets $data:false. The original package and lock files remain in
reports/ajv-upgrade-original-*; the installation diff changes only Ajv and its
formats peer resolution. Installation lifecycle scripts were disabled.

Both the direct installation and ajv-formats peer resolve to 8.18.0. The new
production audit exits zero with no known advisories across 13 production
dependencies. The pre-update finding and clean recheck are retained separately
in reports/production-dependency-audit-2026-11-10.json and its -r2 companion.
Build still passes with seven exact runtime assets. The schema/cache/security
and all-operation core wire compatibility set passed all 295 tests, including
all 279 wire cases, with zero failures/cancellations/skips, duration 125778.7901 ms.
All 140 selected inputs stayed unchanged. The targeted log/counts/hashes are in
reports/ajv-targeted-check-2026-11-10.log and its companion JSON.

The replacement full pnpm check passed all 601 tests across three suites, with
zero failures, cancellations, skips or todos, duration 1229354.43 ms. Its final
output/counts and 140 selected input hashes are in
reports/collection-phase-check-2026-11-10-r2.log and its companion JSON. Both
pre-check and test-phase comparisons match the end, and all selected hashes
matched again at final inspection. The image-observation test input is included.
Generation/build retain 279 exact operations and seven runtime assets. The fresh
wire report matches every official operationId/method/path triple, with empty
missing/unexpected/duplicate sets and all 279 core_wire_pass values true.
All real integration remains not_run. All eight collection regressions pass under
the patched library in this full run, including the native 109/37 workflow.

A fresh compiled schema resource measurement ran 600 repeated validations and
1200 distinct definitions. The cache retained 256 entries / 97992 serialized
bytes after 945 evictions, and the final observed GC heap was 8529240 bytes.
This verifies the configured cache accounting in this synthetic process, not a
whole-process or production heap cap. The command, observations and exact
source/package hashes are in
reports/schema-validation-resources-ajv8180-2026-11-10.json. Earlier measurements
remain historical evidence for the former dependency.

The first collection-phase full check was stopped deliberately, with no final
count or full-success claim, so the updated library/configuration can receive
the required final run. The earlier eight collection-targeted passes were under
the pre-update dependency. Real Immich, full-category acceptance, Linux/container,
Cloudflare and ChatGPT remain unfinished.

## Next sharing/source discrepancy review (2026-11-10)

While the 140-input full check stays frozen, sixteen fixed source files were
inspected for all four Activities, five Partners and two Download operations.
reports/sharing-fixture-source-observations.json records their URLs/hashes and
the scope. No sharing fixture plan or category acceptance is claimed yet.

The fixed ActivityController returns the existing like as ActivityResponseDto
with HTTP 200, while the fixed OpenAPI declares only 201 for createActivity.
A separate native HTTP reproduction using the current compiled executor sent
exactly two caller-key requests: the 201 response had typed JSON, while the same
body at 200 became artifact_result with data:null. The exact original bytes
were retained and no automatic retry occurred. This evidence is in
reports/activity-duplicate-status-reproduction-2026-11-10.json. It is a local
model of the inspected source behavior, not a real Immich test.

After the current full check finishes, add a fingerprint-bound declared 200
response correction and regression coverage. Keep the attached OpenAPI bytes
unchanged and keep unknown response/secret handling strict. The remaining shared
workflow cases must also verify directional partner access and removal, duplicate
activity counts, exact ZIP bytes/CRC and no replay after uncertain writes.
Created A/B partner relationships must be removed before successful completion,
so independent earlier fixture plans retain their expected private-asset refusals.

Final phase inspection keeps the five feature plans at thirteen static referenced
primary tags and 28 unreferenced tags; all 41 real-category gates remain
not_verified. Docker/Podman/nerdctl and the standard Docker Desktop CLI path are
still absent. The goal remains active: the reproduced activity response gap,
remaining category/special-workflow plans and real Immich/Linux/container/
Cloudflare/ChatGPT acceptance remain required.

## Sharing, archive validation and duplicate-response correction (2026-11-10)

Added sharing_fixtures_v1 and pnpm integration sharing-fixtures, with four new
image roles and 105 initial / 30 completed-repeat cases (181 initial
maximum with metadata polls). It represents all four Activities, five Partners
and two Download operations, plus supporting album/asset operations. Completion
requires revoking both A/B partner directions and preserving baseline partner
IDs, private-asset refusals, the final album and exactly two retained activities.
Download planning and ZIP generation are initial-only; completed repeats use GETs.

The reproduced duplicate-like status gap is corrected through a separate
fingerprint-bound JSON response supplement. It copies only the explicitly named
existing DTO for 200, preserves the parsed/attached OpenAPI, and records source
facts for describe. The helper validates all rows before producing corrections,
rejects stale triples/pointers, duplicate targets/facts, non-JSON/error aliases
and DTO mismatches, and requires equivalent target-status secret bindings.
Non-string fact IDs are rejected. Strengthening that guard left generated
registry bytes unchanged.

The bounded ZIP helper validates STORE central/local records, streaming
descriptors, CRC, UTF-8 names, nonoverlap and exact fixture content without disk
extraction. An independently frozen Python zipfile oracle includes Unicode,
an empty member and data descriptors. The oracle SHA-256 is checked. The limits
apply only to this small synthetic archive inspection; opaque production byte
transport is unchanged.

The latest focused generation/build and six response/ZIP tests passed with no
failures, skips or cancellations (duration 1883.221 ms). Both new and duplicate
responses carry typed JSON; unlisted 202 responses remain artifacts and an
unknown credential field is not exposed. Real Immich has not been used.

The first sharing target exposed an undeclared assets field in the test-only
AlbumResponseDto model. The second exposed the model treating the fixed PATCH
album update as PUT. Both runs were intentionally stopped after observed
failures, and their logs and stop-time source hashes remain in
reports/sharing-targeted-check-2026-11-10-initial.json and
reports/sharing-targeted-check-2026-11-10-r2-interrupted.json. Production response
validation and the correctly generated PATCH request were retained.

The corrected r3 sharing suite passed all seven tests, with zero failures,
cancellations, skips or todos, duration 489868.2485 ms. All 149 selected input
hashes matched before/after execution and again before the full run. The native
105-case setup / 30-case read-only repeat passed in 452701.0576 ms, including all
eleven operations and their restricted-key refusals, four exact ZIP responses,
zero remaining A/B partner directions and a later validation failure retaining
historical completion. Lost-response fencing and all four fault cases passed.
The final targeted log/counts/hashes are in
reports/sharing-targeted-check-2026-11-10-r3.log and its companion JSON.

The expanded full pnpm check passed all 614 tests across four suites, with zero
failures, cancellations, skips or todos, duration 1421995.7864 ms and wall time
1428.485 seconds. The same 149 selected inputs matched both the pre-check and
immediately-before-test snapshots, and a terminal audit found no current drift.
The terminal log/counts/hashes are in reports/sharing-phase-check-2026-11-10.log
and its companion JSON. Generation retains 279 exact operations; build passes
with seven runtime assets. The full run includes the native sharing test in
733681.631 ms and all four semantic fault cases. The previous 601-test check
remains historical baseline evidence.

The post-check audit confirms exact operationId/method/path multiset equality
between the fixed official OpenAPI, generated registry and fresh 279-operation
wire coverage report, with no missing, unexpected or duplicate operation. The
compiled registry equals its source copy, and the original OpenAPI SHA remains
632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9.
The explicit createActivity 200 correction shares the declared 201 DTO while
the original remains unchanged. Audit results are recorded separately in
reports/sharing-phase-final-audit-2026-11-10.json. These are local regressions
against synthetic backends, not actual Immich/category or deployment acceptance.

Six feature-plan modules now statically reference sixteen primary tags; 25 tags
have no literal references in those modules. This inventory excludes bootstrap/
adapters and does not establish complete category acceptance. All 41 real
category and full/external acceptance gates remain unverified. Source URLs/
hashes and the historical native reproduction are recorded separately.

## User/profile source inspection for the next fixture phase (2026-11-10)

Twenty-one source files at the fixed Immich commit were retrieved and inspected.
Their hashes and fifteen source findings are recorded in
reports/user-fixture-source-observations.json, including the corrected discovery
of services/system-config.service.ts after config.service.ts returned 404.
The findings distinguish transformed profile-image output, cross-user profile
reads, leaf-wise preference merging, admin soft-delete/restore/asynchronous
removal, public versus user configuration, and conditional license/global OAuth
workflows. This is source evidence only: no new fixture module, semantic test or
real category acceptance is claimed. Candidate mutations are confined to the
owned lab, reversible caller fields or a new throwaway user; original fixture
passwords and unknown existing profile images are not replaced.

The now-completed sharing-phase full check retained its original 149 selected
inputs throughout this inspection. These documentation and source-observation
output changes are excluded from that explicit input snapshot.


## User/profile fixture implementation (2026-11-10)

The user_fixtures_v1 implementation and CLI route now cover profile multipart,
caller name/preference/onboarding changes and restoration, all eleven admin user
operations on a new synthetic user, and public/user configuration. It creates
three synthetic profile inputs, retains one avatar and one active new user,
and preserves original actor passwords and API keys. It uses the common durable
journal rather than replaying uncertain writes. The native run passed with
126 initial cases and 44 read-only revalidation cases in 382926.2326 ms. An
originally true onboarding value adds one restoring initial PUT; the usual
fresh-lab value is false.

The new JPEG/WebP container/frame inspector bounds encoded input to 1 MiB and
dimensions to 4096 each. It is not an entropy/pixel decoder. The independent
Python Pillow 13.0.0 oracle contains six images, including progressive JPEG;
a real Edge browser verifies decoded dimensions and expected colors. Both
focused image tests pass (3913.5546 ms). The initial browser test constructed
a function string without invoking it; it failed and was corrected to execute
the async function before this passing run. Build type narrowing and the
browser result type were corrected without relaxing assertions.

Source inspection now includes twenty-three fixed-commit files. Resolving the
PROFILE_DATA enum exposed an error in the earlier source observation: its wire
value is file, not profileData. The report retains that correction history;
CreateProfileImageDto and the existing serializer were already correct.
The attached OpenAPI and generated registry have not been changed.

The targeted user check passed all nine tests across one suite, with zero
failures, cancellations, skips or todos, duration 433051.8328 ms and wall time
438.453 seconds. All 157 selected inputs, including the new Python generator
and frozen image oracle, remained unchanged. The terminal log/counts/hashes are
in reports/user-targeted-check-2026-11-10.log and its companion JSON. Existing
avatar preflight, lost-user acknowledgement fencing and all five semantic faults
passed. These are synthetic backend/browser/transport regressions only.

The first expanded full check (625 tests expected) was intentionally interrupted
after a separate native reproduction proved that valid null search suggestions
were rejected. Session 97963 returned exit 1; the owned process tree and test
workers were confirmed gone before edits, while two pre-existing services were
preserved. Its partial log and 157 unchanged stop-time input hashes are retained
in reports/user-phase-check-2026-11-10.log and
reports/user-phase-check-2026-11-10-interrupted.json. There are no terminal test
counts or full-pass claim for that interrupted run. The 614-test sharing check
remains historical completed baseline evidence.

Seven feature sources statically reference nineteen tags; twenty-two remain
without literal references. All forty-one real category gates and real
Immich/Linux/container/Cloudflare/ChatGPT acceptance remain incomplete. Positive
license activation, global OAuth unlink and permanent user force removal remain
explicit conditional workflows, not silently removed operations.


## Nullable search suggestions and replacement full check (2026-11-10)

Fixed SearchService source appends null for includeNull:true, unlike the original
string-only inline response item schema. Two requests through the actual compiled
executor and native local HTTP reproduced completed ordinary suggestions but
response_schema_mismatch for the null-containing response. Both originals and
principal boundaries were preserved. The pre-fix JSON/script remain in
reports/search-suggestion-null-reproduction-2026-11-10.*.

The explicit response-shape contract and generator helper now allow null only
for the pinned inline string-array response. Corrections validate original
fingerprints, exact operation/status/MIME/schema, trusted fixed source URLs and
unique facts before applying any row. They cannot alter a response with declared
secret bindings or grant schemas to unknown statuses. Caller inputs and other
operations stay unchanged. The attached OpenAPI hash remains the original value.

All twelve focused response/ZIP/image tests pass with zero failures,
cancellations, skips or todos, duration 3434.7536 ms; all 160 selected input hashes
remain unchanged. The four new tests include native null/Unicode/empty-string
preservation, malformed items, unrelated arrays, unknown statuses and protected
originals. Counts/log/hashes are in reports/search-null-focused-check-2026-11-10.*
and the post-fix two-request observation is separately retained in
reports/search-suggestion-null-fixed-reproduction-2026-11-10.*. It now returns
completed data for both responses, without retry or credential fallback.

The replacement full pnpm check passed all 629 tests across five suites, with
zero failures, cancellations, skips or todos, duration 1395881.818 ms and wall
time 1402.203 seconds. All 160 selected inputs matched both pre-check and
immediately-before-test snapshots; the terminal audit found no current drift.
The final log/counts/hashes are in reports/user-phase-check-2026-11-10-r2.log
and its companion JSON. Generation retains 279 exact operations and build
reports seven valid runtime assets. The native user scenario passed in
688727.7043 ms, and all five user semantic faults passed in the same full run.
Documentation and other output reports are excluded from that explicit snapshot.

The read-only final audit confirms exact operationId/method/path multiset equality
between the fixed official OpenAPI, generated registry and fresh 279-operation
wire report, with 193 paths and 41 tags. Compiled/source registries and the
registry integrity hash match. Original OpenAPI SHA remains
632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9.
Both the explicit createActivity 200/201 DTO correction and nullable suggestion
item correction remain narrow; unrelated string arrays are unchanged. The
pre/post native null reproductions match the current registry, and the interrupted
625-test record retains no full-pass claim. The audit is saved as
reports/user-phase-final-audit-2026-11-10.json. These are local synthetic
regressions, not actual Immich/category or deployment acceptance.

Twenty-six fixed source files now support next-phase discovery preparation,
with twenty-eight findings in reports/discovery-fixture-source-observations.json.
There is no discovery fixture module yet. Inspection now includes asset/search
SQL, metadata extraction, sidecar sequencing and EXIF locking, in addition to
per-endpoint scopes, legacy/structured search, album confinement, locked
visibility, partner flags, aligned time-bucket arrays, map filters and owned
folder views. Structured search needs explicit trashedAt.eq:null for active-only
results, unlike the legacy default. Metadata fallback can clamp future dates
to file birthtime; fixtures need controlled past dates and actual readbacks.
Follow-on job orchestration and lockable definitions remain to inspect before
readiness assertions are finalized.

Seven feature fixture modules still statically reference nineteen tags, leaving
twenty-two without literal references. None of the current local checks proves
actual Immich, all forty-one real categories, Linux/container, Cloudflare or
ChatGPT acceptance; those gates remain open.


## Discovery fixture and time-bucket status correction (2026-11-10)

The discovery_fixtures_v1 source and CLI now stage three new synthetic PNGs
in a preflight-empty controlled July 2023 range, wait for dimensions/EXIF,
write only their metadata, then wait for sidecar/geocoding readbacks. Three
albums confine sharing checks. The scenario covers legacy pages, structured
cursor/OR owner boundaries, random/large/statistics queries, city suggestions,
recent explore items, monthly aligned timeline columns, exact map coordinates
and owned direct-child folder views. Its temporary A-to-B partner relation is
removed and its temporary archive is restored before completion. Completed
revalidation reuses only exact prior non-mutating receipts, including POST
search queries; uncertain writes are fenced by the shared durable journal.
Smart-search and person positive workflows remain explicitly outstanding.

The first targeted run failed five of nine tests because current createPartner
was incorrectly given the deprecated path-ID shape; the request validator
refused unknown_parameter before dispatch. That plan/model error was corrected
to POST /partners with JSON sharedWithId. The second targeted run failed four
of nine tests because the fixed SQL emits a status array absent from the DTO;
projection_mismatch withheld the declared fields along with that unknown
column. The earlier misalignment fault reached the expected case but passed
for the projection error; it now must fail specifically with fixture_assertion.
Both terminal failure logs/counts and unchanged 163-file snapshots are retained
as reports/discovery-targeted-check-2026-11-10-r1.* and -r2.*.

Independent native compiled-executor reproductions isolate the status gap and
its correction in reports/timeline-status-reproduction-2026-11-10.* and
reports/timeline-status-fixed-reproduction-2026-11-10.*. The supplemental
timeline-response-correction contract/helper pins the exact original component
SHA and operation/200/MIME/reference. It adds only an optional status string
array with active/trashed/deleted enum values to this operation's private inline
response copy; shared DTOs, required fields, auth and unrelated schemas are
unchanged. Secret-bearing responses, stale pins and arbitrary widening reject
before mutation. The original OpenAPI remains unchanged.

All sixteen focused correction/ZIP/image regressions pass, with zero failures,
cancellations, skips or todos, duration 5425.8856 ms and wall time 5.938 seconds.
All 166 selected inputs remained unchanged. Evidence is in
reports/timeline-correction-focused-check-2026-11-10.*. The r3 discovery run then failed three of nine tests at large_a: the deprecated
large-asset POST takes query parameters rather than a body. Its counts/log and
unchanged 166-file snapshot are preserved as discovery-targeted-check-2026-11-10-r3.*.
The fourth targeted suite passed all nine tests across one suite, with zero
failures, cancellations, skips or todos, duration 336827.5215 ms and wall time
337.344 seconds. All 166 selected inputs remained unchanged and still match.
The native 90-case setup / 50-case read-only repeat passed in 304187.4339 ms,
including all fourteen positive operations, correct restricted-key outcomes,
changed-readback detection and retained historical completion. Lost-upload fencing,
occupied-month preflight and all five semantic faults pass; each fault now fails
at its expected case specifically with fixture_assertion. Counts/log/hashes are
retained in reports/discovery-targeted-check-2026-11-10-r4.*.

The expanded full pnpm check passed all 642 tests across six suites, with zero
failures, cancellations, skips or todos, duration 1511859.2385 ms and wall time
1517.781 seconds. Generation retains all 279 operations and build reports seven
valid assets. All 166 inputs matched precheck, test-start and terminal snapshots.
The full discovery native scenario passed in 601890.6009 ms; all five semantic
faults and no-replay/preflight cases also passed. Final log/counts/hashes are in
reports/discovery-phase-check-2026-11-10.log and its companion JSON.

The read-only final audit confirms exact original/registry/wire triples, 193 paths
and 41 tags, matching compiled registry/integrity, unchanged global schemas and
original OpenAPI, only the private optional enum status column, preserved failed
r1/r2/r3 records and eight static plans referencing23 tags. It is saved in
reports/discovery-phase-final-audit-2026-11-10.json. The known cluster201 DTO gap
was explicitly recorded as pending at that audit. This completed642 result is
the baseline before the subsequent correction below; actual runtime acceptance
remains incomplete.

Thirty-two source files and thirty-five findings are recorded separately.
Eight feature fixture modules statically reference twenty-three tags, leaving
eighteen without literal references. All forty-one actual category gates and
real Immich/Linux/container/Cloudflare/ChatGPT acceptance remain unverified.


## People/faces/cluster preparation during the frozen full check (2026-11-10)

Twenty-five fixed source files and twenty-three findings are recorded in
reports/people-fixture-source-observations.json, with a separate source inventory.
All twenty-seven People/Faces/Cluster groups operations have their original
method, query/path/body locations, declared statuses and controller API-key
scopes inventoried before fixture implementation. The attempted face.dto.ts path
returned 404; both face/person DTOs are actually in person.dto.ts. Two older
cached support sources lacked exit-status metadata, so they were re-fetched
with HTTP 200 and identical content hashes before recording successful evidence.

Manual face creation is empty 201; face IDs must be read back through the owned
asset. Its input geometry permits nonempty manual workflow checks without face
detection inference. Names/visibility/roles, distinct-asset statistics, database
sharing triggers, source-coordinate transforms and JPEG cropping were inspected.
A target thumbnail size of 250 does not imply upscaling: the source forbids it,
so a 20x20 face at x=5,y=4 in an unedited 64x32 input derives a 22x22 thumbnail.
That remains source-derived until actual execution. Sharing can create a recipient
person row; revocation need not remove that row. Cluster accept/leave can remap
person IDs, so a future fixture needs a dedicated pristine lab or independently
bound new users rather than changing established actor face graphs. No People/
Faces/Cluster fixture implementation or real category success is claimed.

A read-only lexical status-setter scan fetched all forty-five inventoried fixed
controller files successfully. Its three candidates were manually reviewed:
duplicate Activity 200 is already explicitly corrected, uploadAsset declares
both 200/201 originally, and createClusterGroupRequest is missing new-request
201 despite its dynamic controller returning 201 for insertion and 200 for a
duplicate. The scan is limited to explicit res/response status setters; it is
not a complete transport audit. Hashes/excerpts and that limit are retained in
reports/controller-dynamic-status-source-scan-2026-11-10.json.

Two requests through the current compiled executor and native local HTTP now
reproduce new 201 as artifact_result with data:null, while duplicate 200 exposes
the request ID and full DTO. Both originals are retained, foreign result refs
are refused, and there are exactly two requests with no auth fallback. Script
and evidence are reports/cluster-request-status-reproduction-2026-11-10.*.
This known DTO status gap is not corrected yet: the running 642-test input set
remains frozen. Its correction must copy only the explicit declared 200 DTO to
the source-verified 201 and retain unknown-status and secret protections.

All 166 selected full-check inputs still match their precheck hashes during
this inspection. New observation reports and this documentation are excluded
from that input list. The check subsequently passed all642 tests and its audit was saved before
any correction inputs changed. These source discoveries do not prove full acceptance.


## Cluster invitation 201 response correction (2026-11-10)

After the terminal discovery642 audit, the separate
contracts/cluster-request-response-correction.v3.3.5.json contract now copies only
the already declared200 ClusterGroupRequestResponseDto to source-verified201.
The shared status corrector now also validates unique operation matches, exact
row keys, fixed-source TS URLs without traversal/duplicate entries and wildcard
secret ambiguity. Source-status secret rules still need identical target-status
coverage. Validation completes before any operation is changed, response/fact
metadata is detached from callers, and global schemas/auth/catalog triples stay
unchanged. The attached OpenAPI remains unchanged.

Four new regressions exercise the alias, atomic rejection, secret coverage and
native HTTP new/duplicate IDs, invalid DTOs, unknown fields/statuses and unrelated
operations. Together with existing response/ZIP/image tests, all twenty focused
tests pass with zero failures, cancellations, skips or todos, duration6460.8955ms
and wall6.985seconds. All168 selected inputs remain unchanged. Counts/log/hashes
are reports/cluster-request-focused-check-2026-11-10.*. Independent pre/post
native evidence is retained as reports/cluster-request-status-reproduction-2026-11-10.*
and reports/cluster-request-status-fixed-reproduction-2026-11-10.*; both post-fix
requests expose the same invitation ID and preserve originals/principal boundaries.

The full pnpm check passed all646 tests across six suites with zero failures,
cancellations, skips or todos, duration1383166.6384ms and wall1389.078seconds.
All168 inputs match precheck, test-start, terminal and post-check snapshots.
Generation retains279 operations; build reports seven valid assets. The final
log/counts/hashes are reports/cluster-request-phase-check-2026-11-10.log and its
companion JSON. All279 native HTTP wire cases pass in102503.6752ms.

The final artifact audit confirms exact279 operationId/method/path triples,
193 paths,41 tags, matching compiled/integrity hashes and unchanged original
OpenAPI/global schemas. Pre/post cluster native responses preserve IDs, originals
and principal boundaries. Removing only the new201 alias and restoring that
operation original override reconstructs exactly the prior registry hash, proving
other generated definitions are unchanged. The reproducible delta procedure is
reports/verify-cluster-registry-delta-2026-11-10.mjs; output is its companion
cluster-request-registry-delta-2026-11-10.json. The final audit is
reports/cluster-request-phase-final-audit-2026-11-10.json. The previous642 record
is preserved. All41 actual category, Immich, Linux/container, Cloudflare and
ChatGPT acceptance gates remain unverified; People/Faces/Cluster fixtures are
not implemented yet.


## Dedicated people/cluster scenario design (2026-11-10)

Preparation now covers28 fixed sources and24 findings, including admin asset
statistics: omitted visibility covers only default timeline/archive states, so
the fresh-lab guard needs explicit timeline/archive/hidden/locked and normal/
trash queries before changes. The source/design report records the full27
operation request/scope inventory and a dedicated pristine-lab approach. Existing
feature-run history is to be rejected; original passwords/keys stay unchanged.

The blueprint uses three new images, manual faces, scoped temporary people,
current/legacy merges, read/write/admin sharing and JPEG readbacks. A B-owned
manual face in a co-owned person group is intended to prove group-ID remapping
on leave; B solo IDs and A face mappings must remain stable. Mutation refusals
must also be excluded from completed read-only repeats. ML enqueue204 remains
an acknowledgement rather than proof of inference.

The detailed case budget may exceed the current IntegrationRun default256 when
all27 operations and bounded asynchronous observations are included. A proposed
plan-specific384 limit, bounded by512 and authenticated on replay, is recorded
as implementation pending; existing plans must retain their default256 behavior.
No journal-limit change or People/Faces/Cluster fixture code has been made.
This design evidence does not grant any actual category acceptance.


## Dedicated people, faces and cluster workflow (2026-11-10)

The people_fixtures_v1 source and CLI are implemented. The plan requires a fresh,
separately bootstrapped owned lab: it rejects other feature-run journals, requires
three singleton actor groups and no incoming/group invitations, and checks no
listed A/B people plus explicit A/B asset statistics for timeline, archive,
hidden and locked visibility in both normal and trash states before mutations.
It is not a complete enumeration of pending permanently deleted database rows.

The scenario stages three new synthetic images, waits for real dimensions/file
sizes, creates manual faces, verifies per-asset geometry and distinct-asset
statistics, and exercises all 27 People/Faces/Cluster groups operations plus
positive searchPerson. It includes individual/bulk updates, current/legacy
merges, soft/hard face removal, atomic mixed-owner delete refusal, owner-specific
personal fields and read/write/admin person sharing. Album access is checked
separately from person metadata/thumbnail sharing. After revocation, a recipient
copy can remain; after cluster leave, a nonempty co-owned person and B-owned face
must get a new person group while A mappings and B's solo group ID remain stable.

Rejected writes are marked mutating in the journal and never resent during
completed revalidation. Only exact previously passed non-mutating cases repeat.
Manual faces and a regenerate queue acknowledgement do not verify ML inference.
The frozen Pillow JPEG oracle and browser checks cover image decoding/frame and
stable/changed bytes in the local HTTP model, not actual upstream crop pixels.

IntegrationRun now accepts an optional plan limit from 1 through 512, defaults
to the unchanged 256 behavior, and persists nondefault limits in authenticated
encrypted evidence. A completed replay must request the same effective limit.
The people plan uses 384. Three budget regressions passed in 35927.9642 ms with
no failures/skips; they cover overflow before dispatch, invalid limits without
journal creation, legacy compatibility, changed-limit rejection and the existing
mutation fence. The subsequent complete source/harness/tests build passes.

The 12 people HTTP/browser/fault tests and those three budget tests are running
as reports/people-targeted-check-2026-11-10-r1.* with 174 selected input hashes.
No targeted or expanded-full success is claimed until its terminal result.
The earlier 646-test check remains historical evidence for its original inputs.
Actual Immich/Linux/container/Cloudflare/ChatGPT and all 41 real category gates
remain unverified.

The first targeted people check terminated with 15 tests across one suite:
11 passed and 4 failed, with zero cancellations/skips/todos, duration
794869.0561 ms and wall795.406 seconds. All174 selected inputs were unchanged.
The native nominal case and later role/leave faults stopped at create_face_album:
the test model/expectation incorrectly added ownerId/assets fields absent from
this version's AlbumResponseDto. The dropped-invitation fault stopped at the
duplicate request instead of its intended readback. Original counts/log/hashes
remain in reports/people-targeted-check-2026-11-10-r1.*.

The fixture now checks album ownership through albumUsers, checks both shared
face geometries and exact album assets through the official read-only
searchMetadata operation, and treats that POST as a read during completed
revalidation. The HTTP model reuses the existing discovery search model rather
than introducing undeclared album fields. Invitation persistence is read back
before sending the duplicate request. Native failure diagnostics now include
only the sanitized last case/status/assertions, and the nominal test requires
all possible133 extra metadata/thumbnail polls to fit the384 receipt bound.
The corrected source/harness/tests build passes. The second15-test check is
running as reports/people-targeted-check-2026-11-10-r2.* with174 frozen inputs;
no second-run or expanded-full pass is claimed yet.

Next-phase source preparation is separate in
reports/asset-lifecycle-fixture-source-observations.json: eleven fixed sources
and four findings, no fixture implementation. Notably duplicate GET cleans
singleton groups and must be marked mutating, file deletion queues physical
cleanup, and trash response counts do not prove physical deletion. Those facts
must inform the later complete11-operation lifecycle scenario.


The second targeted run terminated with15 tests/one suite:14 passed, one failed,
zero cancellations/skips/todos, duration894352.3434ms and wall895.063seconds.
All174 selected inputs were unchanged. All six schema-valid semantic fault
checks now fail at their intended case with fixture_assertion. The remaining
nominal failure occurred after final_shared_album passed because the added
album query used the non-existent operationId searchMetadata. The official
POST /search/metadata operationId is searchAssets; earlier prose using the
source-style name as a public operationId was incorrect. The two original
failure logs and count/hash records remain unchanged.

The new fixture-operation-ids.test.ts parses property assignments with the
TypeScript AST and compares literal operation_id values in all feature modules
against the attached original OpenAPI's279 unique IDs. An independent negative
probe retains the mistaken name and must be rejected. The pre-fix reproduction
finds exactly the people-fixture error; after fixing the call, all415 literals
across nine modules pass. Logs/evidence are
reports/fixture-operation-id-reproduction-2026-11-10.* and
reports/fixture-operation-id-fixed-check-2026-11-10.*. Dynamic operation tables
remain an HTTP-test responsibility rather than a claim of this static check.

The build passes after the operation-ID correction and the new guard. The
nominal test wall-time ceiling is increased from20 to40 minutes for the
forthcoming expanded full check: the prior full discovery scenario took about
twice its focused-run time under concurrent suite load, and this longer plan
also performs completed revalidation. This changes no request timeout, semantic
assertion, mutation fence or case-count bound.

The third targeted check runs all16 tests/one suite against175 selected inputs
as reports/people-targeted-check-2026-11-10-r3.*. The expected expanded full
suite is662 tests/seven suites, not yet started. No third-run/full pass or actual
Immich/category/deployment success is claimed while these remain pending.

Next-phase asset lifecycle preparation now includes19 sources,12 findings and
all11 target request/scope shapes. It additionally documents source-level
duplicate-ID collision scope, nonempty EXIF/visibility/stack prerequisites and
asynchronous group changes. Three more fixed queue sources were fetched to
evaluate pausing only duplicateDetection, waiting for active=0, and restoring
the original pause state without changing global secret-bearing configuration.
The lifecycle fixture and actual collision/deletion/ML behavior are not yet
implemented or observed.

The follow-up lifecycle report now records27 fixed sources and15 findings,
including file DTO fields, queue DTO/current API, the BullMQ wrapper, media
generation and asset response state. The design remains unimplemented: eight
new images, scoped duplicate queue pause plus bounded active=0, exact original
pause restoration and source-derived file/duplicate/trash readbacks. The
proposed448-case limit needs its final calculation; no lifecycle or actual
queue/deletion/ML execution is claimed. People r3 is still live at the latest
observation, with all175 selected hashes unchanged.


## People targeted pass and expanded full check (2026-11-10)

The third targeted check passed all16 tests across one suite, with zero
failures, cancellations, skips or todos, duration1302363.423ms and
wall1302.89seconds. All175 selected inputs remained identical through testing
and the terminal audit. Native HTTP completed237 initial cases and46 exact
read-only repeats in1027203.7497ms, including all27 positive operations and
all27 restricted-key refusals. The same test detects a later external name
change without resending mutations and retains historical completion. All six
semantic faults, lost face acknowledgement, pristine-lab guards, bounded-case
compatibility, binary JPEG refusal and independent browser decoding pass.
Counts/log/hashes remain in reports/people-targeted-check-2026-11-10-r3.*.

The targeted final audit is reports/people-targeted-final-audit-2026-11-10.json.
It verifies exact279 official operationId/method/path triples,193 paths,41 tags,
unchanged original OpenAPI SHA, and byte-identical source/compiled registry.
The registry remains91447bd73dce1a3c64f332cbcb3a87b5f92ec25a3706fdffe00878364e4ab1f8.
The nominal237 cases plus133 maximum additional asynchronous observations fit
the384 plan bound. Earlier r1/r2 failures and the operation-ID pre-fix
reproduction are preserved. These are local synthetic/browser checks, not actual
Immich crop-pixel, ML or category acceptance.

For the expanded full check, exactly one test wall-time literal changed:
the six shared semantic-fault cases have a30-minute ceiling instead of15.
The focused share-role fault took483114.368ms, and earlier discovery full-suite
contention approximately doubled its focused native duration. Inputs, assertions,
case budget, production request deadlines and no-replay behavior are unchanged.
The old test bytes are exactly reconstructed by reversing this one literal;
the proof is reports/people-full-timeout-adjustment-2026-11-10.json. Every other
selected input matches the passing targeted snapshot.

The full pnpm check is now running as reports/people-phase-check-2026-11-10.*,
expecting662 tests/seven suites. Generation retains all279 operations with no
missing/unexpected/duplicate entries, build validates seven runtime assets, and
all175 adjusted inputs match at test start. Its terminal result is still pending.
No source changes are permitted while this recorded full run remains live.

A fresh read-only prerequisite observation at01:50UTC is saved in
reports/container-readiness-2026-11-10-people-phase.json: Docker/Podman CLI,
the standard Desktop CLI, engine pipe, selected services and configured engine
environment presence are all absent. No installation or engine connection was
attempted. All41 actual category, Immich/Linux/container/Cloudflare/ChatGPT gates
remain unverified; the lack of those prerequisites does not stop remaining
implementation and local verification work.

The asset lifecycle source review also confirms the existing production
Executor/Jobs files are unchanged from the passing646 baseline and do not
automatically retry sent requests by HTTP method. The duplicate-list GET cleanup
therefore needs special fixture revalidation classification, rather than a new
production retry policy. Its later11-operation fixture remains unimplemented.


## People expanded full check completed (2026-11-10)

The full pnpm check passed all662 tests/seven suites with zero failures, cancellations, skips or todos. Duration3055115.48ms; monitor wall3061.328seconds. Generation and build completed first. All175 inputs match at precheck, test start, terminal and final audit. The one post-targeted test wall-time change reverses to the exact passing targeted source. Native people237 initial/46 read-only cases and all six semantic faults passed. No runtime request limit or replay behavior changed.

reports/people-phase-final-audit-2026-11-10.json verifies all279 official triples,193 paths,41 tags, unchanged global schemas, exact source/compiled registry bytes and the original OpenAPI fingerprint. Nine feature modules statically reference26 tags; quoted-string extraction does not prove category acceptance. The full report SHA256 is 56c43652c4f235150812ac9574dcf5e614395a827dbf877c5aee04a3651720e0. All41 actual category and Linux/container/Cloudflare/ChatGPT gates remain open. This supersedes earlier running-state statements while retaining their historical record.


## Asset-file Range and lifecycle implementation (2026-11-10)

The fixed AssetFilesController uses the original-file Express sendFile helper with Range enabled. The previous registry rejected downloadAssetFile Range before dispatch: all3 new regressions failed, including two unknown_parameter failures. The versioned transport contract now adds Range only to that operation. Attached OpenAPI, declared response statuses, global schemas and authentication remain unchanged; reversing only its parameters/override reconstructs the exact passing662 registry SHA. See reports/asset-file-range-registry-delta-2026-11-10.json. The initial post-correction run passed2/3; its describe assertion omitted the established empty $defs container. Correcting that expectation yielded3/3 with176 unchanged inputs and a passing build. Failed logs are preserved. Tests verify closed/open/suffix ranges, full/partial bytes and SHA256, metadata/status404 and416, error withholding, secret transport headers and A/B ownership. Actual Immich Range remains unverified.

The reviewed lifecycle drafts are implemented in src/integration-lifecycle-fixtures.ts with a synthetic HTTP model,15 tests, CLI registration and eight syntheticPhoto roles. The pixel algorithm is unchanged. The plan covers all11 Asset files/Duplicates/Trash operations, queue pause capture/restore, album-versus-file ownership, singleton cleanup GET effects, keeper metadata/tag/album merge, per-item validation, mixed-owner refusals, restore counts and eventual API-row absence. Six Range cases compare partial hashes to full retained bytes and exact statuses/headers. Physical deletion and ML detection remain unverified. After an uncertain sent pause, preserve owned lab evidence; no automatic unpause/replay occurs.

The conservative receipt bound is208 nonpoll+200 polling=408 within authenticated448 and absolute512. Nominal219 initial/36 repeat counts are unexecuted estimates. reports/lifecycle-source-promotion-2026-11-10.json preserves draft provenance and changes. Generation/build passed; the official-ID guard checks479 literal calls in10 modules. The22 targeted tests run as reports/lifecycle-targeted-check-2026-11-10-r1.* with179 frozen inputs (session43903, monitor29632, child27604). Do not change these inputs while live. The expanded full680/eight-suite check has not started. All41 real category and deployment/connection gates remain open.


## Lifecycle small-WebP correction (2026-11-10)

The initial22 targeted run failed at download_a_thumbnail: record initialization required>100bytes, rejecting the independent valid64x32 WebP82/84/86-byte frames. The reproduction is reports/lifecycle-small-webp-reproduction-2026-11-10.json. Native failed at417674.2578ms; initially-paused setup and deeper fault tests met the same prerequisite. Locked-trash, lost-pause and ineffective-pause checks passed in the partial log. The owned test subtree was intentionally stopped after matching child27604 to monitor29632 and its exact command. All179 hashes stayed unchanged. Its terminal report explicitly has counts:null, not a completed22-test result.

Only record length>100 became>0; MIME/frame/dimensions, full/partial hashes, sidecar identity and owner-distinct bytes remain checked. The source reversal is exact in reports/lifecycle-small-webp-fix-2026-11-10.json. Generation/build pass. A one-test native end-to-end rerun is live as reports/lifecycle-native-check-2026-11-10-r2.* (session65780, monitor28012, child9472), with179 unchanged inputs. Keep them frozen until terminal; all22 focused cases and expanded680 full regressions remain required. All actual acceptance gates remain open.

Workflow/plugin preparation now records19 pinned sources for12 operations. It confirms bundled core2.0.1 with14 nonempty-schema methods/3 templates, source-reachable first-step Halted/Error index0, exact query filters, scope-free authenticated trigger reads and logging:false cleanup. The null-method-schema candidate remains conditional because all bundled schemas are nonempty. No workflow/plugin fixture or correction is implemented; see reports/workflow-plugin-fixture-source-observations.json.


## Lifecycle native pass and full focused run (2026-11-10)

Native r2 completed with1 test/1 suite, all passed, zero failure/cancel/skip/todo; duration466023.3335ms and wall472.062seconds. It observed219 initial cases/36 exact read-only repeats, all11 target operations and11 restricted refusals. All179 hashes match precheck/test start/end/current. The408 worst receipt bound fits448. reports/lifecycle-native-final-audit-2026-11-10.json verifies the exactly reversible small-WebP condition, unchanged global schemas/source-compiled registry and a byte-perfect reversal of the eight media role strings to the prior algorithm hash. Physical deletion, automatic ML detection and actual Immich remain unverified.

All22 focused checks now run as reports/lifecycle-targeted-check-2026-11-10-r3.* (session10445, monitor25032, child22624) against the same179 frozen inputs, including all15 lifecycle tests. The three Range tests and479-literal/10-module guard have passed in its current output. No full22 success or expanded680 full success is claimed until observed terminal and audited.

## Draft workflow log response correction (2026-11-10)

The fixed source stores zero-based workflow step order and logs a first-step Halted/Error by step ID, while WorkflowLogEntryDto declares exclusiveMinimum0. The fixed lock pins nestjs-zod5.5.0. Its global serializer passes values through without ZOD_SERIALIZER_DTO_OPTIONS; the workflow controller/Endpoint wrapper set no such metadata and the sole compiler plugin is Swagger. This is a source inference about HTTP reachability, not actual-server execution.

A draft under reports/drafts changes getWorkflowLogs200 application/json only, using a private inline component and removing only lastStep.index exclusivity. The original component SHA is6701a6a67fd6a8cf08f1162e6ccba74243bd1a1fa68632c23087e5799b324543. Strict fingerprints, method/path/pointer/status/MIME/field/source checks prevent arbitrary widening. The first virtual type check found an undefined narrowing issue; its diagnostics are retained. After an explicit missing-component return, type checking passes. reports/workflow-log-draft-native-reproduction-2026-11-10.json records9 real loopback HTTP requests in an independent process: index0 initially fails response_schema_mismatch with its encrypted original retained; the draft accepts0/1/MAX_SAFE, rejects negative/fractional/unsafe indexes, withholds unknown status202 and secret fields, and preserves B isolation. Fifteen invalid contract variants plus duplicate/stale-component guards reject atomically. All179 running test inputs remain unchanged. Only that independent process was temporarily patched; production sources, generated registry, global schemas, input constraints and unrelated operations remain unchanged. The draft is not promoted; actual Immich remains unverified. Fixed-source preparation now records26 Immich sources, one version-specific library source and a separately identified404 bootstrap alias.


## Combined regression sequencing and draft readiness (2026-11-10)

Four future workflow-log correction tests are authored under reports/drafts and pass strict virtual type checking together with the helper. They have not been executed as production regressions. The independent9-request draft reproduction remains the runtime evidence; all179 active lifecycle inputs stayed unchanged. The promotion manifest records the three exact draft hashes and mandatory focused/native/delta checks.

The full regression plan now combines the lifecycle/Range680 baseline and4 log response tests as684 tests/eight suites, with182 inputs after promotion. Finish and audit the current22-test lifecycle session10445 before any production edit. Then promote the narrow helper/contract/tests, register generation, reconstruct the priorfac115be registry and exact old generator bytes, and pass the4 focused tests before launching reports/run-lifecycle-workflow-phase-check-2026-11-10.py. This supersedes the prepared but unstarted680-only monitor. No684 success, promotion or future-test execution is claimed yet.

A fresh local-container check at03:58:54UTC found no Docker/Podman CLI, standard Docker Desktop CLI, local engine pipe or configured DOCKER_HOST/CONTEXT. Its named-service query returned1, so an empty service result alone does not establish service absence; the report marks that inventory unverified. No container action or installation occurred. The signed lab cannot run here without an available Docker CLI/engine. Local implementation and focused tests continue, and all actual category/deployment gates remain open.


## Lifecycle focused pass and promoted log response correction (2026-11-10)

All22 targeted r3 tests passed with zero failures/cancellations/skips/todos, duration1839282.1591ms, wall1839.859seconds. All179 inputs match precheck/test start/end/current. Parallel native again observed219 setup/36 read-only cases. Every semantic fault, lost pause, originally paused queue and byte/privacy guard passed. reports/lifecycle-targeted-final-audit-2026-11-10.json proves all279 triples, unchanged global schemas/compiled registry,479 literal calls/10 modules/31 referenced tags and408 worst receipts within448. Actual category/deployment and physical deletion/WASM/ML remain unverified.

The reviewed workflow-log helper, contract,4 tests and generator hook are now promoted. Generation keeps279/193/41. Only getWorkflowLogs200 receives its private nonnegative index schema; the original component remains exclusiveMinimum0 globally. reports/workflow-log-registry-delta-2026-11-10.json proves reverting its response/override reconstructs exact registryfac115be74492f60eb179482b8c22107c7d8b225ee2bfa7c6aa9dc0e5201a15e, and the generator registration reverses byte-for-byte to the passing targeted source. The new registry SHA is589e3331c7b1e7b35964cee83beb3297211aca5676e881f1833caa38e18d7643. Exactly3 existing inputs (generator/registry/integrity) changed and3 new files were added.

Build and all4 correction regressions passed, duration9952.2019ms/wall18.906seconds, with182 unchanged inputs. Source/compiled bytes and exact scope are audited in reports/workflow-log-focused-final-audit-2026-11-10.json. The combined pnpm check684/eight suites is running as reports/lifecycle-workflow-phase-check-2026-11-10.* (session19841, monitor27472, child27456). Generation279 and build7/integrityok completed; test-start182 hashes match precheck. Keep all182 inputs frozen until terminal. The earlier662 remains the latest completed full baseline; no684 pass or actual Immich/Cloudflare/ChatGPT acceptance is claimed. The unstarted680-only monitor is superseded.


## Workflow/plugin draft and query-validation evidence (2026-11-10 04:51UTC)

The workflow/plugin fixture draft is complete under reports/drafts/workflow-plugin-fixture-2026-11-10.ts.txt. It uses AssetTagged after observing all three synthetic photos as favorite:false; two A-owned flows exercise favorite effects and first-step Halted logs, while B remains unaffected. It also checks step replacement/preservation, reduced exports/defaults, deleted and foreign workflow refusals, logging:false cleanup, log ordering/filters, restricted writes with state readback and final read-only validation. No source fixture or CLI command has been promoted.

reports/drafts/workflow-plugin-fixture-static-check-2026-11-10.json records zero strict TypeScript errors, no unknown literal operation IDs and all12 Workflow/Plugin operation IDs referenced. The synthetic role extension exists only in the virtual compiler overlay and reverses exactly. All182 frozen combined-regression inputs match before/after. This is static draft evidence, not executed integration or a proven receipt budget; native HTTP harness, semantic-fault tests and lost-ack/repeat validation remain required.

The independent reports/workflow-query-boolean-probe-2026-11-10.json uses exact upstream-pinned Zod4.4.3 with verified npm archive integrity. Its11 own-loopback HTTP requests preserve false/true wire strings: eight reconstructed boolean-query refusals and three string-query controls pass. Fixed Nest pipe/validate source calls schema.parse without coercion. Thus boolean search-query400 is a source-derived expectation awaiting actual Immich/Nest/Express verification; do not silently drop filters or claim repository-level filtering implies HTTP acceptance. No active dependency or executor change was made.

Pinned TagService awaits successful AssetTag emission; EventRepository awaits handlers and workflow execution awaits queueAll. The draft therefore drains workflow jobs after tag acknowledgement before checking B non-effect. These source facts and all new hashes are recorded in reports/workflow-plugin-fixture-source-observations.json.

The full684/eight-suite check remains the same live session19841. No684 pass is claimed. The latest completed full regression remains662, with targeted lifecycle22 and promoted workflow-log4 separately passing. Actual category/deployment/Cloudflare/ChatGPT acceptance remains open.


## Current completion gates and full684 failure (2026-11-10)

The combined full684 run is terminal:683 passed,1 failed, no cancellations/skips/todos. reports/lifecycle-workflow-phase-terminal-audit-2026-11-10.json independently verifies all182 recorded inputs unchanged, matching source/compiled registry, unchanged global schemas and exact279 operation triples. The sole failure is upstream_transport_interrupted in the initial native lifecycle laboratory version observation, before feature execution. No server handler error was reported. Its root cause is unconfirmed; no production timeout, authorization, replay policy or semantic assertion has been relaxed.

The workflow fixture, three synthetic media roles, workflow-fixtures CLI command and source-derived core manifest/HTTP state model are now in source. TypeScript build passes. The first workflow monitor failed on cp932 reporter output; the owned child was authoritatively absent and no descendant remained before the UTF-8 retry. This is a monitor failure, not a passing test run. reports/workflow-targeted-check-2026-11-10.monitor-error.json preserves that distinction.

The UTF-8 workflow test run found an invented usage field in the synthetic admin-statistics response. reports/workflow-stat-model-probe-2026-11-10.json independently observes projection_mismatch for that extra field and completed exact data for only images/total/videos. This requires a model-only correction after the current run becomes terminal. Workflow acceptance is not yet claimed.

Source-reference coverage now spans11 fixture modules and33 primary tags;8 tags have no feature-plan literal references. This is a static planning metric, not category execution. All41 real category gates remain unverified. The dedicated workflow fixture still requires its positive native run, semantic-fault/lost-ack tests and a read-only repeat to pass; then lifecycle transport isolation and a complete updated regression remain required.

Real Linux/container durability and deployment, all real Immich category/special-adapter tests, Cloudflare Managed OAuth/Tunnel and actual ChatGPT file/long-job workflows remain open. No production server, photo library, external account or credentials have been guessed or changed.


## Workflow13 pass, nullable-method4 pass and final local regression (2026-11-10 07:02UTC)

The workflow/plugin group passed all13 tests with no failures/cancellations/skips/todos, duration3329280.3883ms/wall3334.359seconds. All187 selected inputs match precheck/test start/end/current. The native path observed185 initial cases and56 read-only repeated cases, with state-drift rejection and the full lost-ack/ownership/persistence/log-clearing/hidden403-effect fault set. Worst bounded receipts are394 within448. Evidence: reports/workflow-targeted-final-audit-2026-11-10.json.

The manifest/table/mapper review and independent13-request native HTTP reproduction established null method schemas as a reachable source-derived response shape. The reviewed correction is now generated only into getPlugin/searchPlugins/searchPluginMethods200 private inline schemas. Global components, requests, permission contracts, statuses and all other operations remain unchanged. reports/plugin-method-registry-delta-2026-11-10.json reconstructs the exact prior589e333 registry from the new871d98963afa469d2ac441a2243cca075b96be1ca4c7b37cb9edf436d152ac7d. Four focused regressions and build pass, duration13060.7108ms/wall18.891seconds, with190 unchanged inputs and equal source/compiled registry. See reports/plugin-method-focused-final-audit-2026-11-10.json.

The two exactly reversible scheduling changes lower test-file concurrency4→2 and lifecycle-suite concurrency3→2. They change no production deadline, assertions, scope, permissions or replay policy. The prior full684 native version-probe interruption remains an unconfirmed cause; resource contention is an inference, not a proven diagnosis.

The prepared final local monitor requires both focused groups, the exact generated registry and190 matching inputs, then runs pnpm check with704 expected tests/nine suites. No704 pass is claimed yet. The user requested implementation/local verification first; all actual Immich/Linux/container/Cloudflare/ChatGPT gates remain deferred and explicitly unverified. Source packaging is gated on the final704 pass and matching source hashes; no archive exists yet.


## Empty sync terminal regression and local recheck (2026-11-10 08:25UTC)

The704 full run was intentionally stopped after actual sync semantic assertions failed and an independent SyncProjection/ResultPages reproduction confirmed that declared empty completion/reset data{} became a withheld marker. Its monitor is terminal exit1; no aggregate704 pass/fail count was emitted. The verified own test subtree stop and190 unchanged inputs are recorded in reports/local-final-check-2026-11-10.intentional-stop.json. Native lifecycle219/36 and people237/46 passed earlier in that partial run; these observations do not constitute a full run pass.

Only src/projection.ts, src/json-projection.ts and the existing empty-object regression file changed afterward. Actual{} for an explicit empty-properties schema is preserved; nonempty arbitrary objects remain protected. Build and the independent two-terminal probe pass. The new regression covers both terminal types and encrypted ordinary JSON empty/nonempty values; final expected coverage is705 tests/nine suites. A durable six-file sync/projection/nullable focused run is active as reports/empty-sync-focused-check-2026-11-10.* (session88343), with190 unchanged test-start hashes. Fresh full-run, final-audit and source-package guards are prepared under -r2 filenames, and packaging remains gated on a complete green705 run. No actual Immich/Linux/container/Cloudflare/ChatGPT gate is verified.


## Focused sync36 pass and fresh full705 run (2026-11-10 08:47UTC)

The repaired six-file focused run is terminal:36 tests/one suite all passed, with zero failure/cancellation/skip/todo. Duration1512923.4559ms/wall1520.953seconds includes native sync paged snapshots, owner-isolated child checkpoints, all delta/reset paths and read-only repeat, plus lost-ACK, wrong checkpoint scope, ineffective ACK, foreign-row, incomplete/interrupted stream and strict projection guards. All190 hashes match before/test start/end/current. Reports: empty-sync-focused-check-2026-11-10.json and empty-sync-focused-final-audit-2026-11-10.json. Exact in-memory reversal of both production source changes reconstructs the previous704 source hashes without editing live files.

The guarded sequential pipeline92748 now runs reports/local-final-check-2026-11-10-r2.* with705 expected tests/nine suites. Generation279, build7/integrityok and190 unchanged test-start hashes pass. Keep these190 files frozen until terminal. The prepared finalizer runs only after a complete green705 result and independent audit; it updates current documentation and creates/verifies the source-only archive. No705 pass or actual Immich/Linux/container/Cloudflare/ChatGPT acceptance is claimed yet.


## Local implementation delivery verification (2026-11-10)

The repaired sync/projection/nullable focused group passed all36 tests/one suite with zero failures/cancellations/skips/todos. The fresh pnpm check then passed all705 tests/nine suites, again with all other counts zero. Generation reports279 exact operations and build verifies7 runtime assets/integrityok. All190 selected inputs match precheck/test start/end/current. Full-test duration is 6147576.1744ms and monitor wall time 6154.703seconds. Evidence: reports/empty-sync-focused-check-2026-11-10.json, reports/local-final-check-2026-11-10-r2.json and reports/local-final-audit-2026-11-10.json.

The independent audit verifies279 operationId/method/path triples,193 paths,41 tags, all nine tool names, all279 core wire checks, unchanged original global components, equal source/compiled registry and exact reversal of the three private nullable-plugin corrections. Empty completion/reset{} remains exact and arbitrary nonempty plugin schemas remain protected. The failed/stopped704 run and earlier failures are historical evidence, not successful full checks.

This completes the requested implementation/local verification stage. Source packaging is guarded by the final report hash, final audit and exact190 source hashes. Actual Immich/all41 real category, Linux/container durability/deployment, Cloudflare and ChatGPT acceptance remains deferred/unverified; full_acceptance remainsfalse. Conditional OAuth, external library, maintenance, SMTP, physical deletion, ML and WASM effects are not established by local models.
