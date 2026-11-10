# Changelog

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
