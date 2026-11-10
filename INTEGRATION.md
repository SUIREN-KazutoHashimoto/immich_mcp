# Isolated Immich 3.3.5 integration environment

This is a disposable test stack, separate from the production deployment in DEPLOYMENT.md.
The commands prepare, start, observe and tear down the backend infrastructure, and
bootstrap synthetic users and API keys. Media and explicit-authentication scenario phases are available; the complete 41-category acceptance
runner and real-host execution remain unfinished.

## Prerequisites and placement

Run the commands from this checkout on a machine with Node.js 24, pnpm 11.25.0,
Docker Engine running Linux containers and the Docker Compose plugin. The supplied
application image does not include Docker CLI access or the Docker socket.

The Docker endpoint must be a local Unix socket or Windows named pipe.
The runner resolves the selected context once per command, pins the socket for every
subsequent invocation, and verifies the daemon ID against the first start.
SSH/TCP daemon endpoints are rejected because the published loopback port would belong
to a different host. To use another Docker host, execute these commands on that host.

Choose a new absolute run directory outside the checkout and Docker build context.
Its parent must already exist. The command refuses an existing destination.
The directory contains owner keys, a database password and signed run metadata;
keep it private. POSIX creation modes are 0700 for the directory and 0600 for its
initial files. On Windows, protect the parent with your account's filesystem ACL;
cross-platform permission behavior remains a real-host acceptance check.

Example on Linux:

```sh
pnpm integration prepare --directory /absolute/private/immich-tests/run-001 --port 22835
pnpm integration up --directory /absolute/private/immich-tests/run-001
pnpm integration check --directory /absolute/private/immich-tests/run-001
```

On Windows, replace the directory with an absolute path such as
C:/Users/your-user/ImmichMcpTests/run-001, whose parent already exists.
Do not load a production .env file or supply a production IMMICH_BASE_URL.
There is no upstream URL option.

## What is created and checked

Preparation creates a UUID-based Compose project, a compose.yaml file, a random
DB_PASSWORD in .env, a 32-byte .run.key, a separate .vault.key for
encrypted test fixtures, and a signed run.json. It does not invoke Docker.
The manifest authenticates the source version, OpenAPI hash, configuration hashes,
canonical path and physical directory identity. Moving/copying the directory,
editing the configuration or losing its owner key prevents its normal use.
Do not repair ownership by editing or re-signing run.json.

The four services follow the dependencies and image references in the
[fixed Immich source Compose file](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/docker/docker-compose.yml):

- New payload-v2 runs pin the v3.3.5 server and machine-learning OCI indices by digest.
- Postgres and Valkey use the digests recorded in that fixed source.
- Library, database, model cache and Redis each use a new project-specific named volume.
- Database and Redis use the run's internal bridge network. Server and machine learning
  also use a dedicated egress bridge for dependencies such as model downloads.
- Only the server is published: 127.0.0.1:22835 by default. Database, Redis and machine
  learning have no published ports. Containers use restart: no.
- No existing external network, host photo/database directory or Docker socket is mounted.

up records its start intent and daemon identity before asking Compose to start services.
A partial startup can be inspected or retried against the same owned infrastructure.
It checks both Compose-project and run-specific labels, exact service/image references,
named mounts, volume drivers/options, network membership and loopback port bindings.
Unexpected resources are rejected before a new start or teardown operation.
An exclusive SQLite owner lock prevents competing commands from operating on one run.

check requires all four containers to be running and healthy, all four volumes and
both networks, then requests only the fixed loopback /api/server/version endpoint.
The response is size-limited, schema-checked and must identify stable 3.3.5.
HTTP redirects are rejected. Image IDs and container IDs appear in the JSON observation.

Public GHCR OCI indices for both v3.3.5 application images were observed and their
received-byte SHA-256 matched the registry digest headers. Publisher annotations name
the fixed source commit, and the indices list Linux amd64/arm64 descriptors; see
reports/immich-image-manifests.json. A follow-up by immutable digest also checks Linux amd64/arm64 child manifests and
image configs for server/ML, including their source labels. Filesystem layers, image
signatures, actual pulls and observed runtime IDs remain Docker-host checks. New
runs use the pinned policy below; existing v1 runs retain their original references.

The same follow-up verified all four fixed indices and Postgres platform/config
metadata. Valkey platform metadata remains incomplete after HTTP 401 and a bounded
anonymous-token retry timeout. The report records that gap separately; it does not
establish that a real Docker pull succeeds or fails.

## Run format and image policy

New prepare commands create signed payload version 2. All four services use
immutable digest references. Server and machine-learning references use the
observed v3.3.5 OCI index digests; Postgres and Valkey retain the digests from the
fixed Immich Compose source. Pulling a digest selects a fixed image reference as
described in the [Docker digest documentation](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier).
Actual pulls and platform/container execution still need a Docker host.

| Signed payload | Server / machine learning | Existing-run behavior |
| --- | --- | --- |
| 2 | Fixed repository@sha256 index references | New runs use this policy. |
| 1 | Original v3.3.5 tag references | Start, check, stop, restart and explicit deletion retain their original policy. |

The signed envelope format and owner-key/HMAC protocol remain version 1; the
authenticated payload version selects the image policy and full Compose template.
A v1 run is not rewritten or upgraded. Its dedicated volumes, owner/vault keys and
fixture-server identity remain in the same namespace. To choose the new policy,
prepare a separate new run instead of editing an existing manifest.

up and check verify signatures, physical ownership, file hashes, the exact
version-selected parsed Compose template and the generated dotenv format before
invoking Docker. Altered image references, host mounts, database destinations,
public ports, extra commands or extra environment entries are rejected even if
their hashes were signed. down uses the authenticated version and resource
ownership checks and can still operate without the Compose/env files. A valid
reference from the other policy is not accepted as an existing container's image.

Preparation/readiness observations expose manifest_version,
image_reference_policy and configured_images_pinned. The latter describes the
selected references, not verified image layers, signatures or container behavior.
Existing v1 observations explicitly report legacy_tags and false. Unknown or
missing signed payload versions have no image-policy fallback. Keep a CLI build
that supports the run's version for later checks/teardown.

## Output and evidence limits

Commands emit one JSON result. Docker stderr and arbitrary exception messages are not
forwarded; failures expose only a diagnostic code. Passwords and owner keys are not
printed or passed as command-line arguments. Compose config runs with --quiet.
Do not run unredacted docker compose config or share docker inspect environment output.

prepare reports execution_scope: preparation_only and docker_executed: false.
A real up/check reports execution_scope: docker_observation.
Injected Docker or HTTP adapters used by unit tests always report harness_only.

A healthy backend observation still reports api_integration_completed: false and
full_acceptance: false. It establishes backend readiness only. The existing
reports/operation-coverage.json is the separate 279-operation core wire/mock report;
neither report proves real API effects, Cloudflare routing or ChatGPT connectivity.

The bootstrap phase creates synthetic accounts/keys as described below. The remaining
feature phases must extend the media and explicit-authentication fixtures and execute all
41 categories and special adapters, recording successes, upstream refusals and
unmet environment conditions separately. Production data is excluded.

## Bootstrap synthetic accounts and keys

After up/check succeeds, initialize the fresh disposable backend:

```sh
pnpm integration bootstrap --directory /absolute/private/immich-tests/run-001
```

The command holds the same exclusive run lock from backend verification through
the end of initialization, so down cannot remove the stack midway through setup.
Its HTTP client is bound to the verified loopback origin through the direct upstream
pool; provisioning requests use separate connections across local storage work.
It does not use an environment HTTP proxy or accept another upstream URL. Ordinary
application traffic retains its existing pooled default; no request retry is added.

The public context first checks getServerConfig.isInitialized and refuses an already
initialized server. It then creates one synthetic administrator and two general users
A/B, using reserved example.invalid addresses, random passwords, no email notification
and no required first-login password change. These are test accounts only.

Public signup/login use the existing explicit public context and common executor,
including protected password references and encrypted/sanitized results. User creation
uses only the new administrator's API key. Initial key creation is a separate,
explicit own-session setup request, necessary before registering a first API key.
It never runs as a fallback after a normal API-key refusal.

Four independent caller bindings are registered and verified with getMyApiKey:
administrator/all, A/all, B/all, and a second A-owned key with only asset.read.
The restricted principal receives no saved password or session. Registration does
not add user.read or apiKey.read. General users remain non-administrators.
This phase does not enable general-session/PIN execution modes.

Passwords, login sessions, input secrets, original responses and setup receipts are
stored in the encrypted fixtures/ vault, using the separate original .vault.key.
The fixture store is bound to this run and fixed endpoint; symlinked directories,
missing/changed keys and incompatible identities fail closed. Local private files
remain after Docker teardown, as documented below.

A durable encrypted started receipt precedes the first backend mutation, and each
request records its dispatch before sending. If a response is lost, a projection or
write fails, or the process dies, bootstrap refuses to repeat the partial setup.
There is no automatic account/key recreation or session fallback. Review retained
evidence, then delete that disposable stack with the explicit volume-deletion
command and prepare a new run. There is no automatic rollback or recovery command.

Repeating a completed bootstrap performs only four getMyApiKey requests with the
same original key IDs and stored caller keys, checking the recorded fixture owners.
It preserves binding revisions and never repeats signup,
user creation, login or key creation. Revoked/changed credentials cause a failure.
The report records the latest credential check, timestamp, affected role and observed
status separately from the historical account-setup completion state.

bootstrap-report.json contains setup operation/actor/route/status observations and
all 279 operation triples and 41 category placeholders. No passwords, sessions,
response bodies, input secrets or secret references are published. The report is
setup evidence only: feature integration remains not_run, and Cloudflare, ChatGPT
and full acceptance remain incomplete.

Any injected Docker/HTTP adapter marks the run as harness_only in signed run state.
This provenance is sticky, and an encrypted bootstrap created with a harness cannot
later be promoted to real integration evidence.

## Synthetic media fixtures and semantic cases

After account bootstrap, create and check the disposable media dataset:

```sh
pnpm integration fixtures --directory /absolute/private/immich-tests/run-001
```

The command first revalidates all four original caller keys and their recorded owners,
then holds the same exclusive run and fixture-store ownership throughout the phase.
It uses the normal common executor and the production Control resolver for staged
files and protected references. It does not mount or access Immich's database/photo
directories, and it does not select a different upstream or credential after refusal.

Three deterministic 64 by 32 PNG images are generated from the private run ID:
an A-owned sharing candidate, a separate A-owned private image, and a B-owned private
image. The sharing candidate also has an XMP sidecar. Filenames include Japanese
characters. Originals and sidecar data are staged into encrypted caller-owned storage.

The first run executes 42 named semantic cases, including:

- New upload 201 and one deliberate duplicate-upload 200 with the same asset ID.
  The duplicate is an explicit test case, not an automatic retry.
- User identity/non-admin checks, owner-only key listing and exact fixed version.
- Asset ID, owner, SHA-1, original filename and caller-specific favorite display.
- Exact downloaded bytes and SHA-256 for each original and the shared viewer.
- Empty album creation, per-item add success, membership and asset counts.
- A private album and a separate album explicitly shared with B as viewer.
- Ownership refusals before sharing and continued refusal for the separate private
  image/album after sharing, using the fixed version's 400 responses.
- The restricted A-owned key can read its owner's asset, but its missing download
  and album-create permissions return 403 without a session fallback.
- Tag creation/assignment, retrieval and isolation between A and B.

A 200 response alone does not pass a case. Every case requires its named assertions
to be evaluated, and bulk arrays must report the expected item's success.
Original downloads are compared with the generated bytes, not merely their MIME type.

The first run returns fixtures_ready only after all cases pass and the encrypted
completion state is committed. A completed run can be repeated: it executes only
26 read/verification cases, preserving the images, albums, shares and tag.
Every repeated request must match an originally passed non-mutating case in actor,
operation, inputs, expected status and the same assertion-name set. New or disguised mutation
requests are rejected before sending.

The encrypted media_fixtures_v1 journal records prepared/sent/passed/failed/outcome_unknown states,
observed statuses and evaluated assertion names,
exact operation triples and private result references before and after requests.
Unknown effects or failed first-run assertions fence mutation replay. A later
read-only validation failure is reported separately from historical fixture completion.

media_fixtures_v1.report.json contains only named case/status/assertion evidence,
timestamps and the official operation triples. Request bodies, files, private refs,
credentials and response payloads are excluded. It lists all 279 operations and
41 categories, with six categories represented by this phase: Server, Users,
API keys, Assets, Albums and Tags. Remaining categories are not completed by this plan.

Injected adapters remain harness_only and report zero real success/refusal counts,
even when their semantic cases pass. A real default-transport run can record observed
cases, while api_integration_completed, completed_41_category_acceptance and
full_acceptance remain false. The earlier operation-coverage.json remains the
separate core wire/mock report.

PIN/shared-link cases are provided by the separate auth-fixtures command below.
Video/Range/HLS cases are provided by video-fixtures below. Sync, OAuth, maintenance
and remaining categories/special workflows still require scenario expansion.
All fixture plans still require real Immich execution. Their production
API/adapters are separate from these fixture plans.
No real Immich account/media effects, Docker execution, Cloudflare or ChatGPT
integration have been verified in the current environment.

The case expectations follow the fixed
[access checks](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/utils/access.ts),
[asset mapper](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/dtos/asset-response.dto.ts)
and
[upload service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/asset-media.service.ts).
A viewer does not inherit the owner's favorite flag. For a photo with sidecar the
plan omits the optional global filename override, allowing each multipart file's
own extension to be checked; other photos exercise the explicit filename field.
The fixed
[upload conversion](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/utils/asset.util.ts)
decodes the original multipart filename from Latin-1 bytes to UTF-8.

## Explicit PIN, session and shared-link fixtures

After bootstrap, run this independent authentication phase:

~~~sh
pnpm integration auth-fixtures --directory /absolute/private/immich-tests/run-001
~~~

It can run alongside the media fixture plan: its three generated PNG variants are
separate from that plan's images. It creates an A-owned ordinary image, a separate
A-owned locked image and a B-owned private image. It configures a random six-digit
PIN on synthetic user A and creates two password-protected A-owned shared links.
One link is later expired deliberately; the other keeps downloads disabled.

The phase explicitly registers the original bootstrap sessions for A/B through
the production Contexts implementation. It verifies their own current sessions,
checks the default special-workflow mode and refusal without mode consent, then
explicitly enables general-session mode for these synthetic contexts. The limited
principal receives no session. API-key bindings are preserved. This is a
programmatic test of the production registration/mode APIs, separate from the real
Cloudflare/control-UI/ChatGPT acceptance gate.

The original bootstrap sessions must remain valid. New fixture contexts last at
most 24 hours. A completed repeat does not log in, renew credentials or recreate
expired contexts; an unavailable or changed context fails verification.

The first run evaluates 60 named cases, including four local refusals before
dispatch. Cases verify:

- PIN configuration, wrong-PIN refusal, API-key-only unlock refusal, explicit
  session elevation and exact locked-original bytes.
- Unlocking does not enable general-session mode. The owner's normal API key
  remains unelevated, another owner's session stays isolated, and the limited
  key's missing download permission is not replaced by a session.
- Explicit relocking and the resulting asset/original refusals.
- Shared-link key and slug registration to B, password login, and link-owner and
  exact asset membership assertions.
- Independent cookie jars for different contexts and links, including refusal
  when another link's password is supplied.
- Password rotation invalidates old key/slug cookies; the new password succeeds.
- Expiration rejects both key and slug, while the separate download-disabled
  link remains readable and rejects downloads and assets outside its membership.
- Normal B API-key calls retain their ordinary owner/link isolation.

Passwords, PINs and non-null request slugs use operation/context-bound protected
references. Response keys/passwords/slugs, cookies, originals and fixture state
stay encrypted. The public report excludes inputs, credentials, result references
and context references.

The result is auth_fixtures_ready only after encrypted completion is committed.
A repeat returns auth_fixtures_revalidated after 17 previously passed,
non-mutating cases: 16 executor HTTP requests and one local cross-principal
refusal. Backend/version and original-key preflight reads are separate from these
named case counts. No uploads, PIN setup/unlock/lock, link login, password edits,
expiration changes or context registration/mode changes are replayed.

The encrypted auth_contexts_v1 journal pins actor, operation, input, context
reference/generation, expected status/error and assertion names. Local refusals
have kind local_refusal, no HTTP status and no sent receipt; they are counted
separately from upstream refusals. A dispatched response cannot be relabelled as
a local refusal. Completed verification cannot switch to another context,
generation or ordinary API-key route. The common journal also supports the fixed
302/307 transport corrections, keeping Location credentials encrypted.

auth_contexts_v1.report.json lists all 279 operation triples and 41 categories.
This phase represents 13 operations under Assets, Authentication, Sessions and
Shared links. Combined with media fixtures, named cases span nine categories;
neither phase completes a category or the full 41-category acceptance matrix.
Injected adapters remain harness_only with zero real-case counts. The real
Docker/Immich, Cloudflare and ChatGPT gates remain unfinished.

A lost unlock acknowledgement or a failed first-run semantic assertion retains
the started/sent evidence and fences mutation replay. A later verification
failure preserves historical completion and records a failed latest_validation.
The report-publication and recovery rules below apply to this command as well.

Expectations follow the fixed
[AuthService](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/auth.service.ts),
[asset access repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/access.repository.ts),
[SharedLinkService](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/shared-link.service.ts)
and
[shared-link controller](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/controllers/shared-link.controller.ts).
The controller's password cookie handling is exercised with encoded token values
and multiple Set-Cookie headers; unrelated session cookies are excluded.

## Short video, Range and HLS fixtures

After bootstrap, run this independent phase:

~~~sh
pnpm integration video-fixtures --directory /absolute/private/immich-tests/run-001
~~~

The plan video_fixtures_v1 uploads separate A/B-owned synthetic H.264 MP4s.
The frozen contracts/synthetic-video.v1.json contains programmatic color frames
and a moving square, 320 x 180, about 3.94 seconds, with no audio, camera capture,
screen capture or external media. Its original encoded bytes have SHA-256
99bd1d2cd7c603d33797493620f82377d1dccc7b45269a079f5dc15cd1d4eded.
An inert MP4 free box makes each run/role checksum unique. The command itself
does not require a browser or host ffmpeg. Regeneration is an explicit developer
operation using scripts/generate-video-fixture.ts --output ABSOLUTE_NEW_JSON,
requires a supported installed browser, and never overwrites an existing file.
A regenerated encoding must be reviewed and its frozen hash updated deliberately.

The phase reads and privately retains the complete admin configuration. It
temporarily enables realtime HLS for integer resolution 480 and codec h264, and
disables background playback transcoding to keep this fixture's full-file and
Range requests on the original artifact. Both settings are restored from the
exact saved configuration after the HLS scenario. Known nested OAuth/SMTP secret
fields, including empty strings, use operation-bound protected references rather
than inline request values. Before restoring, the current configuration must still
match the configured fixture state; unexpected changes stop acceptance.

Cases cover owner/checksum/Unicode filename and video metadata, exact original
bytes and SHA-256, original Range 206, full playback, byte and suffix playback
ranges, range headers and an unsatisfiable playback request. The last case
expects 404 from the fixed Immich file helper: callback errors are forwarded as
NotFoundException while a response can still be written. It does not replace the
upstream status with 416. The separate core wire test still verifies preservation
of 206/416 if those statuses are actually received. Metadata readiness
uses at most 60 distinct non-mutating observations per asset with two seconds
between pending observations. Failed reads do not trigger another upload.

The HLS path uses the owner's ordinary API key, checks the master and VOD media
playlists, requests init.mp4 and every declared seg_N.m4s, forwards
x-immich-hls-pos/x-immich-hls-msn, checks bounded MP4 container framing and
acknowledges endSession. Playlist references are parsed into fixed operation/path
arguments; no arbitrary playlist URL is fetched. Owner and restricted-scope
refusals are checked without trying another credential.

All HLS operations, including their GETs and refused requests, are conservatively
marked mutating: creating sessions, prewarming, heartbeats and segment production
are not repeatable read-only observations. An end acknowledgement is recorded
separately from worker cleanup; hls_worker_cleanup_verified remains false.
Container framing is not a codec validation of real server output. The browser
test separately decodes the frozen original and init-plus-fixture-fragments into
the expected changing frames; this is not real Immich HLS-player acceptance.

With immediately ready metadata and the current two-segment source fixture, the
first run evaluates 40 named cases. A completed repeat evaluates 20 matching
non-mutating cases plus separate backend/key preflight reads. It does not repeat
uploads, HLS requests/end calls, configuration changes or metadata polling.
Configuration, playback baselines, session IDs and originals remain encrypted.
The public video_fixtures_v1.report.json omits inputs, references and secrets and
keeps actual category/full-acceptance gates open. These cases represent ten
operations in Assets and Config (admin), not completed category acceptance.

A failed initial setup preserves the original configuration and sent receipts,
and requires recovery of the disposable run. It does not automatically restore
configuration or end a possibly created session after an uncertain response.
Preserve the evidence and explicitly tear down the disposable stack; do not
repeat setup mutations. A later read-only validation failure retains the
historical completed state.

contracts/transport-overrides.v3.3.5.json adds original-download Range forwarding
without modifying the attached original OpenAPI or contracts. The fixed
[asset media controller](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/controllers/asset-media.controller.ts)
uses the shared
[file response helper](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/utils/file.ts),
which delegates to Express sendFile without disabling its default Range support.
See [Express response documentation](https://expressjs.com/en/5x/api/response/#res.sendFile).
The received HTTP statuses are preserved; source inspection and local synthetic
206/416 responses do not prove the actual server's error-status behavior.

HLS expectations follow the fixed
[service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/hls.service.ts),
[controller](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/controllers/video-stream.controller.ts),
[video repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/video-stream.repository.ts),
[constants](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/constants.ts)
and
[metadata extraction](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/metadata.service.ts).
Source hashes and the verification limits are recorded in
reports/video-fixture-sources.json. Actual Docker/Immich execution, HLS decoding
from that real server, remaining categories, Cloudflare and ChatGPT remain open.

## Session-bound synchronization fixtures

After bootstrap, run the independent synchronization phase:

~~~sh
pnpm integration sync-fixtures --directory /absolute/private/immich-tests/run-001
~~~

The sync_fixtures_v1 plan uploads separate synthetic sync_a/sync_b PNGs and
creates three one-day child sessions: A, a second session for A, and B. It uses
the original synthetic A/B setup sessions only to create those children. Their
existing synchronization checkpoints are not changed. Each child is connected
through the production owner-verification workflow in its default special mode;
general-session mode is not enabled. Additional session authentication does not
inherit API-key permissions. The restricted principal receives no session.

The initial run evaluates 72 named cases. Separate context-registration/owner
verification and existing backend/key preflight requests are not included in that
count. Scenarios verify:

- Distinct child/current session IDs and separate checkpoints for A/B and for two
  sessions belonging to A.
- All four normal API-key-only sync calls are refused; existing contexts do not
  become an automatic fallback. API-key-only child-session creation is refused.
- AuthUsersV2/AssetsV2 snapshots, source row ordering, checksums, Unicode filenames,
  owner isolation and the dedicated image's favorite update appearing as a delta.
- Exact ACK persistence, per-type deletion, full asset replay after deletion and
  the absence of automatic acknowledgement by the selected stream handlers.
- Invalid ACK-type refusal without checkpoint changes.
- A deliberately old completion checkpoint producing SyncResetV1, acknowledgement
  of that terminal clearing checkpoints, explicit reset:true, and a session
  marked pending reset. Other sessions' saved positions stay independent.
- Final checkpoint and image state, API-key refusals and cross-principal context
  references rejected before dispatch.

Snapshots may contain other synthetic data from earlier fixture plans. They do
not assume that only the two new images exist. The fixed service's snapshot
watermark is one millisecond behind database now; the favorite-update case allows
a short five-millisecond interval after confirmed readback before requesting its
delta. Failed or uncertain streams, ACKs and child-session creation are never
automatically replayed.

The fixture framework now has an internal complete_jsonl result view, allowed only
for a successful getSyncStream case. A paged inline preview is accepted only when
its retained projection is complete, decoded inspection completed, the original
transfer was not interrupted, and a valid terminal exists. The sync helper reads
all sanitized pages, compares their order and formal data with the encrypted
original, and checks every non-null PIN against its principal/context/revision
bound secret reference. Null PINs remain null. This plan does not set or change a
PIN. The controlled fixture budget is at most 2048 records and 8 MiB decoded
originals; this is separate from the production executor's limits.

This view is not a new MCP argument and does not relax the default fixture rule.
Other fixture responses still reject truncation. Missing terminals and interrupted
bodies fail even when the internal view is selected. Local tests use more than 16
snapshot records so that real paged-result handling is exercised, including
multiple UTF-8 chunks and PIN canaries.

All getSyncStream cases are conservatively marked mutating. Some fixed handlers
write backfill checkpoints, and reset:true explicitly changes session progress.
A completed repeat runs 11 matching non-mutating cases (ten HTTP requests and one
local refusal), plus separate preflight reads. It does not recreate sessions,
upload, update favorites, stream, acknowledge, delete or reset progress. The
children/contexts expire within one day; verification after expiry fails rather
than renewing or reconnecting them. The A fixture image remains favorited.

Tokens, session IDs, checkpoints, original JSONL and PIN values remain in the
private encrypted fixture vault. The public sync_fixtures_v1.report.json omits
inputs, result/context references and private state. A lost ACK response preserves
the sent/outcome-unknown receipt and requires recovery of the disposable run.
A later verification failure retains historical completion and records the
failed validation. The publication/recovery rules below apply to this plan.

The plan names ten operations across Sync, Sessions and Assets. Together with the
other three feature plans, static references cover eleven primary tags; this is
not completed eleven-category acceptance. Full-category, all-41-category, real
Immich/Linux/container, Cloudflare and ChatGPT acceptance remain open. Other sync
request/entity types, partnership/album backfills and real service effects still
require their own scenarios and execution.

Expectations follow the fixed
[sync service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/sync.service.ts),
[sync repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/sync.repository.ts),
[checkpoint repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/sync-checkpoint.repository.ts),
[ACK serialization](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/utils/sync.ts),
[session service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/session.service.ts)
and
[session reset transaction](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/session.repository.ts).
Hashes and the verification limits are in reports/sync-fixture-sources.json.

## Memory and stack collection fixtures

After bootstrap, run this independent phase:

~~~sh
pnpm integration collection-fixtures --directory /absolute/private/immich-tests/run-001
~~~

The collection_fixtures_v1 plan uploads six separate synthetic PNGs (four for A,
two for B). It uses the original ordinary A/B/restricted API-key bindings, with no
session connection, automatic credential fallback or administrator substitution.
Image IDs, inputs and results remain in the private encrypted fixture vault.

The usual initial run has 109 named cases, including six first-attempt metadata
observations. Stack queries require EXIF rows, so readiness is bounded to twenty
observations per image, one second apart. Additional polls can raise the total to
223 cases, below the shared 256-case journal limit. Readiness waits never repeat
uploads. Backend version and original-key preflight reads are separate.

All eight Memories operations and seven Stacks operations receive named successful
cases and separate restricted-key 403 cases. The scenarios check:

- Memory creation filtering out a foreign asset, mixed add results (success,
  duplicate and no_permission), repeated removal returning not_found, exact
  membership readback and persisted saved/date/seen changes.
- An empty memory remaining readable and counted in statistics while excluded
  from search; deletion subsequently changes the saved-memory total.
- Owner-only memory access, ID/date/saved filters, pagination and foreign searches.
  Saved totals are compared with each owner's captured baseline, rather than
  assuming that no other fixture or automatically generated memories exist.
- Stack creation, merging all children of an existing primary into the new stack,
  removal of the previous stack, primary-first response order and a persisted
  primary change.
- Rejection of a nonmember primary, removal of the primary, removal of a nonmember,
  foreign asset creation and cross-owner modifications.
- Atomic refusal of mixed-owner bulk deletion, single and bulk deletion readback,
  preservation of the underlying photos and correct detached/final stack links.

Successful completion retains two memories and two stacks, owned separately by A
and B, plus all six synthetic originals. A completed repeat executes only the 37
previously passed non-mutating verification cases. It never uploads, creates,
updates, merges, removes members or deletes. A later mismatch records failed
validation while preserving historical completion.

Every mutation, including refused writes, has a durable journal receipt. A lost
merge acknowledgement leaves outcome_unknown and fences all subsequent retries;
the plan does not infer rollback from a missing response. Publication and
recovery follow the rules below. The public collection_fixtures_v1.report.json
omits inputs, private state, credential values and result/context/file references.

Expectations follow the fixed
[memory service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/memory.service.ts),
[memory repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/memory.repository.ts),
[bulk asset helpers](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/utils/asset.util.ts),
[stack service](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/stack.service.ts)
and
[stack repository](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/repositories/stack.repository.ts).
Source hashes and inspection limits are in reports/collection-fixture-sources.json.

This adds Memories and Stacks to five feature-plan modules' static references:
thirteen primary tags, with 28 unreferenced there. It does not complete these
categories' acceptance or establish real API integration. Birthday generation,
hidden/trashed assets, scheduled cleanup and broader lifecycle combinations
still need their own cases; all real Immich, Linux/container, Cloudflare and
ChatGPT acceptance gates remain open.

## Activities, directional partners and ZIP fixtures

After bootstrap, run the independent sharing phase:

~~~sh
pnpm integration sharing-fixtures --directory /absolute/private/immich-tests/run-001
~~~

The sharing_fixtures_v1 plan uses four new synthetic PNGs, one new album and the
original ordinary A/B/restricted API-key bindings. It captures both directions
of each owner's existing partner list before any mutation, and requires no
existing A/B relationship. Unrelated baseline partner IDs are preserved.

The initial run has 105 named cases when all four metadata observations
are immediately ready. Each image has at most twenty readiness observations,
one second apart, so the maximum initial count is 181. A completed repeat has
30 previously passed non-mutating checks. Version/original-key preflights are
separate. Readiness waits never upload the same image again.

All four Activities, five Partners and two Download operations are represented,
including the deprecated partner-create route. Cases verify:

- Album membership and the activity-enabled flag, with the fixed PATCH update
  method; valid comments/likes, exact author/asset associations and filters.
- Duplicate likes returning the same ID with 200 and not increasing counts.
  New activities return 201. Authors and album owners delete their own permitted
  activities; a viewer cannot delete the owner's comment.
- Incoming versus outgoing partners, default inTimeline:false, recipient-only
  flag changes and giver-only removal.
- Partner asset read/download while the timeline flag is false, owner-only asset
  updates and caller-only user-wide download planning.
- Both new partner directions removed before completion. Removing one direction
  must preserve the other; final private-asset access is refused again.
- Download planning from explicit IDs and a shared album, exact EXIF-derived
  sizes, and groups that may exceed the threshold by the size of the final file.
- Four real HTTP archive responses: owner originals, a repeated filename with
  the fixed +1 suffix, an album viewer and a partner. Membership, CRC and original
  bytes/SHA-256 are checked from the retained encrypted response.
- Mixed-owner, nonmember and restricted-key refusals without credential fallback.

The fixture ZIP reader is bounded to 2 MiB encoded bytes, 32 entries, 256 KiB per
entry and 1 MiB total payload. It accepts the selected small STORE archives,
validates central/local records and descriptors, and rejects traversal names,
overlapping data, corruption, encryption, compression and ZIP64. It never writes
archive entries to disk. These are fixture inspection limits. Production binary
transport retains opaque bytes under its configured result/storage limits.

Successful completion retains the album, two activities and all four originals,
with neither new partner direction left active. Completed repeats send only
GETs: no relationship mutation, comment/like, download planning or ZIP generation
is replayed. A lost relationship acknowledgement remains outcome_unknown and
requires a fresh disposable run. A later read-only mismatch keeps historical
completion and records failed validation. Public reports omit inputs, file/
result/context references, bodies and credential values.

The fixed activity controller has a 200 duplicate-success path missing from the
attached OpenAPI's declared 201 response. The generated registry now includes an
explicit response correction from contracts/response-corrections.v3.3.5.json.
It pins version/commit/OpenAPI hash, operation/method/path/pointer, source status,
MIME and DTO reference. Status-bound secrets require matching target-status
bindings; unknown statuses do not acquire a schema. The attached OpenAPI remains
unchanged. Source facts are visible through describe.

Focused tests verify 201/200 typed JSON, unknown-status/field withholding, stale
correction rejection and the independent Python-generated stored-ZIP oracle.
All seven sharing native/fault tests pass, including the 105-case setup and
30-case read-only repeat. The earlier sharing-phase full check passed 614 tests; inspect
DEVELOPMENT.md for counts, unchanged input hashes and evidence scope. Fixed source URLs/hashes are in
reports/sharing-fixture-source-observations.json. All real Immich/category,
Linux/container, Cloudflare and ChatGPT acceptance remains open.

## Profile images, user preferences and administrative user fixtures

Both focused image tests and all nine user HTTP/fault tests pass. The expanded
replacement full check passed all 629 tests across five suites; real Immich acceptance remains unverified. Use only the owned initialized laboratory:

~~~bash
pnpm integration user-fixtures --directory /absolute/path/to/owned-run
~~~

Initial preflights require both original A/B profile paths to be empty and a
unique synthetic email. Three generated PNG inputs use the actual multipart
field file: A is created/replaced, B is created/deleted, and only the new final
A image is retained. Profile reads verify JPEG/WebP container dimensions and
exact retained byte hashes across permitted readers. The bounded frame inspector
does not decode entropy or prove arbitrary image validity; independent Pillow
encoder data and native-harness output are decoded by real-browser tests.
Pillow is required only to regenerate tests/profile-image-oracle.json using
scripts/generate_profile_oracle.py, not to run the MCP server or fixture command.

The caller's changed name and preference leaves are restored, omitted preference
siblings are checked, and onboarding returns to its original observable value.
Original A/B/admin credentials are never reset. Admin CRUD, preferences,
statistics, sessions and calendar heatmaps operate on a new synthetic user.
It is soft-deleted/restored, has no assets or sessions, and is retained active.
Both a non-admin all-permission key and the restricted key must receive 403 for
all eleven admin operations. User config requires its scope, while public config
and defaults are checked as visibility projections for all four original keys.

The usual initial workflow has 126 cases and completed repeats have 44 prior
non-mutating reads. An originally true onboarding value adds one restoring PUT
to the initial workflow only. The shared durable sent/no-replay journal is retained. A lost account
creation response cannot cause account/avatar/preference recreation. Existing
avatar data fails before any upstream mutation. Positive license activation,
global OAuth unlink and permanent force-removal remain separately pending;
they are not established by the user phase or its local mock server.
The source inspection report corrects the earlier mistaken profileData
spelling: the fixed enum PROFILE_DATA resolves to file, which the existing
OpenAPI-based serializer already used.

## Nullable search-suggestion responses

The fixed source appends null when getSearchSuggestions receives includeNull:true,
while the attached OpenAPI declares string-only array items. A native HTTP
reproduction with the actual compiled executor/vault confirmed the original
response_schema_mismatch and retained the exact encrypted original. After the
specific response-shape correction, both ordinary and null-containing replies
complete with their original data and principal isolation.

contracts/response-shape-corrections.v3.3.5.json pins version/commit/OpenAPI hash,
operation/method/path/pointer, 200 status, JSON MIME and the exact original inline
string-array schema. The generator adds nullable only to its items. It rejects
arbitrary schema widening, stale/duplicate facts and response-secret bindings;
unknown statuses and unrelated string arrays keep their original contracts.
The original OpenAPI remains unchanged.

The four new correction tests pass within twelve focused response/ZIP/image
tests. The earlier 625-test full run was intentionally interrupted before editing
source; no overall pass is claimed for it. Its partial log and worker-stop/input
evidence remain separate. The replacement full check passed all 629 tests across
five suites, with zero failures, cancellations, skips or todos and 160 unchanged
selected inputs. A post-check audit confirms exact official/registry/coverage
triples, unchanged original OpenAPI and the narrowly corrected response schema.
Inspect DEVELOPMENT.md and the companion reports for evidence scope.
These synthetic local replies do not establish real Search-category acceptance.

## Report publication failures

The encrypted account/feature completion record is committed before the optional
plaintext report is published. If publishing fails, fixture_report_failed is returned;
a confirmed completion is retained. Repair the private report destination and repeat
the same command: bootstrap only checks its existing keys, and fixtures/auth-fixtures/video-fixtures/sync-fixtures only execute
their previously passed non-mutating verification cases. No completed account, key,
upload, album, share or tag operation is replayed.

A completed journal is closed to additional requests. A new revalidation instance
must match its earlier non-mutating cases. Merely labelling a different request as
non-mutating cannot add it to a completed plan. A failure before encrypted completion
is committed still follows the conservative recovery-required/no-replay rule.

## Stop, restart and delete

Default teardown removes this run's containers and networks, while keeping its four
named volumes. A later up reuses those volumes and the unchanged private configuration.

```sh
pnpm integration down --directory /absolute/private/immich-tests/run-001
pnpm integration up --directory /absolute/private/immich-tests/run-001
```

To delete the disposable backend data, explicitly request volume deletion:

```sh
pnpm integration down --directory /absolute/private/immich-tests/run-001 --delete-volumes
```

Deletion intent is saved before teardown. The run cannot be restarted after that
intent, even if cleanup is interrupted; repeat down with --delete-volumes to finish.
A repeated teardown rechecks Docker even after an earlier destroyed result, so late
resources from a disconnected Compose client can be detected and removed by the
same explicit deletion command. The default down refuses to resume a deletion intent.
Prepare a new run directory for the next test instance.

Teardown validates the signed manifest and current Docker ownership independently
of compose.yaml/.env, so an accidentally missing or edited configuration does not
force manual deletion. It re-inspects each resource immediately before removal.
It does not use force removal or docker system prune, and does not recursively delete
any host directory. Local private files remain for review and must be handled separately.

A lost owner key, invalid manifest, copied directory, changed daemon or unexpected
resource fails closed. Do not substitute another project's labels or key.
Docker command timeouts can leave backend work continuing after the client disconnects;
inspect the run and repeat the explicit check/teardown command before considering it gone.

## Diagnostic codes

| Code | Next action |
| --- | --- |
| docker_unavailable | Install or select a working Docker CLI on the test host. |
| docker_failed / docker_timeout | Check daemon/Compose availability and image pulls; inspect the owned run before retrying. A client timeout does not prove backend work stopped. |
| lab_remote_daemon | Execute on the Docker host with a local Unix socket or Windows named pipe. |
| lab_engine | Use the original Linux Docker daemon; do not substitute another host. |
| lab_authentication / lab_manifest / lab_path | Preserve the original private directory/key; review ownership before any manual cleanup. |
| lab_changed | Restore the original configuration for startup, or use owned teardown without modifying the manifest. |
| lab_not_ready / lab_version | Check service health and exact stable 3.3.5; this is not an integration pass. |
| fixture_not_fresh | Keep the initialized backend unchanged; prepare a fresh disposable run. |
| fixture_recovery_required | Do not repeat partial account/key/media/authentication/video/sync/collection mutations; preserve evidence, explicitly delete the disposable stack and prepare a new run. |
| fixture_report_failed | Preserve the committed dataset, repair the report destination and repeat only its existing read-only checks. |
| fixture_validation_failed | Inspect latest_validation; the historical fixture creation is retained and no mutation was replayed. |
| fixture_response | Inspect the latest credential_check and original encrypted response; do not recreate accounts or try stored sessions. |
| fixture_key / fixture_key_identity / fixture_owner / fixture_key_permissions | Preserve the original private key, caller binding and fixture owner; never substitute another account or key. |
| lab_deletion_pending | Repeat down with --delete-volumes to finish the already recorded deletion intent. |
| lab_foreign_resource / lab_resources / lab_mounts / lab_network / lab_port | Stop and review the unexpected resource; the command did not adopt it. |

## Current verification

The complete pnpm check passes all705 tests/nine suites with zero failures, cancellations, skips or todos. Generation verifies279 exact operations, build verifies seven runtime assets, and all190 selected inputs match precheck/test start/end/current. The repaired sync/projection/nullable focused group also passes all36 tests/one suite. Reports: reports/local-final-check-2026-11-10-r2.json and reports/local-final-audit-2026-11-10.json.

Local tests use synthetic HTTP backends, a signed Docker command model, real local SDK/browser clients and actual temporary SQLite/files/processes. All eleven feature groups pass in this full run. These results verify local implementation and modeled state/refusal/recovery behavior; no Immich Docker server was executed.

All279 generic execution paths/core wire checks and nine MCP tools are implemented. Eleven source fixture modules statically reference33 primary tags; eight tags have no feature-plan literal references. All41 real category/special-adapter gates remain unverified. Local modeled refusals are distinct from actual upstream refusals.

Actual Immich, Linux volume durability/container execution, conditional OAuth/library/SMTP/maintenance effects, Cloudflare and ChatGPT acceptance remain deferred and unverified. Historical running/failure statements below are retained as chronology and superseded by this current-status section and the latest final audit.

## Fixed source references for account setup

Key ownership and preservation of the requested permission list follow the fixed
[ApiKeyService](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/api-key.service.ts).
User creation and its explicit notification option follow the fixed
[UserAdminService](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/services/user-admin.service.ts).
These source checks do not replace runtime verification of the new bootstrap command.


## Discovery queries, timelines, maps and folders

The discovery-fixtures implementation passes all nine targeted regressions.
Its native local model uses 90 initial cases and 50 read-only repeat cases; actual
metadata polls and distinct asset folders can add cases, with at most 205 receipts.
The completed discovery check passes all 642 tests with 166 unchanged inputs.
A subsequent cluster-invitation 201 correction passes twenty focused tests; its
646-test full check passes all 646 tests with 168 unchanged inputs. Use only the owned initialized lab:

```sh
pnpm integration discovery-fixtures --directory ABSOLUTE_RUN_DIRECTORY
```

The plan first requires empty A/B partner lists and no searchable A/B assets
in July 2023. It stages three distinct synthetic PNGs, checks dimensions and
file sizes, changes only their date/GPS/rating/description metadata and waits
for actual post-sidecar/geocoding readbacks. Reverse geodata must be available;
a bounded timeout preserves the journal instead of repeating writes. Coordinates
are compared within 1e-6 degree after EXIF serialization.

It retains three private/shared albums and three images, removes its temporary
A-to-B partner relation and restores its temporarily archived image. Queries
cover legacy pages, structured cursors and mixed album/owner OR branches,
statistics/random/large-file results, city suggestions, recent explore data,
monthly column arrays, exact marker membership and owned direct-child folders.
The large-file operation is POST with query parameters and no body. Limited
asset.read keys must succeed at the relevant search/timeline routes, while
statistics/person/map/folder scopes have their separate 403 checks.

Time-bucket SQL includes a status array missing from the original DTO. The
separate pinned response correction exposes only this optional known enum array
for getTimeBucket 200 application/json, preserving shared schemas and all
unknown-field/secret protections. Original OpenAPI and raw responses are retained.

Completed repeats send only previously passed read cases, including POST search
queries. A changed readback fails the latest validation while preserving historical
completion; uncertain uploads and metadata writes are never replayed. Positive
searchSmart remains outstanding. Positive searchPerson is covered by the
dedicated people plan locally; actual runtime acceptance remains outstanding. These local synthetic
regressions do not establish real Immich or category/deployment acceptance.


The cluster-invitation response correction is independent of a cluster workflow
fixture. Fixed source returns 201 for a new request and 200 for a duplicate;
the original OpenAPI declares only 200. The supplemental contract copies only
that explicit DTO to 201, preserves declared-status secret coverage and leaves
unknown statuses opaque. Pre/post native reproductions retain both original
responses and foreign-reference refusals. All twenty focused correction/image/
ZIP tests pass; the new full646 check also passes all646 tests across six suites. The earlier full642
result is the prior-source baseline, not proof of this subsequent registry change.
The dedicated people/face/cluster workflow is implemented and locally tested; actual Immich acceptance remains unverified.


## Dedicated people, faces and cluster lab

The people-fixtures command passes all16 local targeted tests, including237
initial native cases and46 exact read-only repeats. The expanded662-test full
check passed with175 unchanged inputs; actual runtime acceptance remains unverified. Use a new owned run which has only bootstrap history; other feature
plans must use a different run. Original bootstrap passwords and API keys remain
unchanged. This workflow creates only synthetic accounts/media in the private
disposable stack and has no arbitrary upstream URL option.

```sh
pnpm integration prepare --directory /absolute/private/immich-tests/people-001 --port 22836
pnpm integration up --directory /absolute/private/immich-tests/people-001
pnpm integration bootstrap --directory /absolute/private/immich-tests/people-001
pnpm integration people-fixtures --directory /absolute/private/immich-tests/people-001
```

The plan refuses other feature journals or non-pristine actor data before any
upstream mutation. It checks normal/trash statistics explicitly for all four
visibility states, not merely default timeline/archive. Three images and manual
faces exercise all 27 People/Faces/Cluster groups operations, positive person
search, hidden/favorite pagination, merges, deletion, role sharing and group
accept/leave with a nonempty face remap. It retains three named person rows,
six visible manual faces, three images and one shared album. A soft-deleted face
can remain in the database and an unused old cluster can remain; these return
values do not assert physical database row totals.

The shared journal defaults to 256 cases. This plan authenticates a 384-case
limit, with an absolute permitted cap of 512. Completed repeats send exact
previously passed read cases only, excluding even rejected write attempts.
A changed readback preserves historical completion and fails latest validation.
An uncertain write requires evidence preservation and a new dedicated lab.

JPEG bytes are inspected with the bounded frame/container helper and stable
hashes. The independent frozen model oracle is browser-decoded, but no real
Immich crop-pixel, similarity-search or face-recognition success is claimed.
Regeneration 204 is a queue acknowledgement only. Docker/Linux and real
Immich/Cloudflare/ChatGPT acceptance remain outstanding.


## Dedicated asset-file, duplicate and trash lab

The lifecycle-fixtures command is implemented and all22 focused tests pass, including all15 lifecycle HTTP/state/fault checks and219 initial/36 read-only native cases. The known small-WebP false refusal is fixed. The complete705 full regression passes; actual Immich remains unverified. Use a fresh owned lab with bootstrap history only, enabled trash and unpaused backgroundTask/sidecar/metadataExtraction/thumbnailGeneration queues. Keep it separate from other feature plans.

```bash
pnpm integration prepare --directory /absolute/private/immich-tests/lifecycle-001 --port 22837
pnpm integration up --directory /absolute/private/immich-tests/lifecycle-001
pnpm integration bootstrap --directory /absolute/private/immich-tests/lifecycle-001
pnpm integration lifecycle-fixtures --directory /absolute/private/immich-tests/lifecycle-001
```

Eight new PNGs/three sidecars exercise four Asset files, four Duplicates and three Trash operations. Groups are assigned through official bulk asset updates; this does not prove ML detection. A scoped duplicateDetection pause restores its original flag on success. The scenario checks derivatives/Range, album-viewer versus owner access, sidecar-delete refusal, group cleanup/merge, selected/whole restore and eventual API absence while preserving B. It retains seven images, two albums and two tags. API absence does not prove physical file deletion. Completed repeats perform stable reads and exclude getAssetDuplicates because that GET cleans singletons. Sent effects are never automatically replayed. Failed runs preserve private receipts and require a new dedicated lab; owned teardown remains available via down.


## Dedicated workflow and plugin lab

workflow-fixtures is implemented and passes all13 local HTTP/state/fault tests. Its normal native path observes185 initial semantic cases and56 exact read-only repeats. Use its own fresh signed lab with bootstrap history only, no admin/A/B assets in any visibility/trash state, empty A/B workflow lists and an unpaused workflow queue. It waits within bounded polls for the bundled immich-plugin-core2.0.1 catalog.

~~~sh
pnpm integration prepare --directory /absolute/private/immich-tests/workflow-001 --port 22838
pnpm integration up --directory /absolute/private/immich-tests/workflow-001
pnpm integration bootstrap --directory /absolute/private/immich-tests/workflow-001
pnpm integration workflow-fixtures --directory /absolute/private/immich-tests/workflow-001
~~~

The plan covers all12 Workflow/Plugin operations: global core catalog visibility,14 methods/three templates, step creation/replacement/preservation, exact private/shareable exports, versioned method normalization, foreign/deleted workflow refusals and restricted operations. Scope-free trigger discovery remains allowed for the restricted key; the other11 operations require their upstream permissions. Source-derived uncoerced boolean-query400 responses retain false/true wire values; actual Nest/Immich behavior remains unverified.

Three synthetic PNGs and two A-owned flows use AssetTagged: one changes favorite state, while an independent nonmatching file filter halts at zero-based step0. Queue draining and exact log IDs/order/filter/result checks verify effects and B isolation. logging:false clears prior logs; restored logging permits the second effect. Both workflows are disabled on normal completion. The lab retains three images, two tags, two disabled workflows and three logs. The authenticated448-case budget covers the394 worst bounded receipt count.

Run the same workflow-fixtures command again only for exact recorded read-only validation. It never repeats a write after a lost acknowledgement. Inspect preserved private receipts after any uncertain mutation; use a new dedicated lab rather than replaying it. No custom plugin installation, external webhook/email, actual WASM execution or production data is exercised by the local model.

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
