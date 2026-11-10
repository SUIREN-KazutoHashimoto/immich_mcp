# Third-party material

The repository's existing LICENSE is retained unchanged. The project license statement applies to independently authored project material and does not relicense third-party material.

The fixed Immich3.3.5 OpenAPI, inventory, provenance and related specification material are bundled under immich_mcp_spec_v3.3.5. The original Immich license is retained in immich_mcp_spec_v3.3.5/api/LICENSE.immich, and source identity is recorded in api/source-manifest.json. Generated API definitions in src/generated/registry.json originate from that OpenAPI and the explicitly source-pinned correction contracts.

tests/workflow-core-manifest.fixture.json reproduces the core plugin manifest from the pinned Immich source commit8303cb117e197c700332b33b61b45314c9cc5bb4. Its source/hash provenance is recorded with the fixture verification.

The production Docker image includes the original Immich license under /app/licenses/immich and source metadata under /app/metadata/source-manifest.json. Installed npm dependencies retain their package license files; exact dependency versions and integrity hashes are recorded in pnpm-lock.yaml.

This is an unofficial integration project, independent of the Immich server and official TypeScript SDK.
