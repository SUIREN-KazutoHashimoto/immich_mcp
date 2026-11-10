# Changelog

## Unreleased — ChatGPT image content (2026-11-11)

- Add read-only `immich_read_image` returning top-level MCP ImageContent from a caller-owned completed image result. Preserve the nine existing tools and asynchronous result references.
- Resize and orient JPEG/PNG/WebP, strip metadata, bound bytes/pixels/concurrency/conversion time and recheck authorization before returning images. Do not publish URLs or persist plaintext previews.
- Add legacy and modern official-SDK tests over native HTTP, image/security regressions and a Japanese ChatGPT acceptance guide. Actual ChatGPT visual recognition remains an environment acceptance check.

## 1.0.0-beta.3 — 2026-11-11

- Fix native control-page form submissions being rejected as `invalid_origin`: HTML now uses `Referrer-Policy: same-origin` so the browser sends its same-origin Origin rather than `null`. Other response policies and strict Origin/CSRF checks remain in place.
- Add a real-browser regression for key registration, redirect completion, secret-free rendering and CSRF rejection. Explicitly retain rejection of null and missing Origins.
- Use a version-neutral connection heading for the reviewed Immich 3.3.5 and 3.3.6 servers.

## 1.0.0-beta.2 — 2026-11-10

- Accept stable Immich 3.3.6 after comparing its official OpenAPI and server implementation against 3.3.5. The OpenAPI differs only at `info.version`; the 279 operations, schemas and server API implementation are unchanged.
- Keep the bundled 3.3.5 contract and reject unreviewed versions and prereleases. Preserve authentication, per-user credentials, storage and master-key handling.
- Record upstream commit hashes and API hashes in `reports/immich-3.3.6-compatibility.json`; publish a separately versioned GHCR image for GUI upgrades.

## 1.0.0-beta.1 — 2026-11-10

First beta of the MCP application, targeting Immich3.3.5.

- All279 official operations and nine MCP tools.
- Per-user keys, explicit authentication contexts, encrypted storage and protected results.
- Persistent jobs, uncertain-outcome fencing, file staging and resumable uploads.
- Streaming JSON/JSONL, binary/Range/HLS and local SDK/browser/failure regressions.
- Versioned Docker image metadata, a standalone beta Compose stack and Japanese Docker test instructions.
- A manually dispatched GitHub workflow builds a Linux amd64 image, runs container health/restart smoke checks and attaches the image/checksums to the draft prerelease.

The full local705-test baseline and release-focused verification are recorded separately.
The Docker smoke uses a synthetic upstream version endpoint. Real Immich category, Cloudflare and ChatGPT acceptance remains to be confirmed.
