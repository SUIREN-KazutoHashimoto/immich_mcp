# Project delivery instructions

User preference established on 2026-11-11: requested implementation changes in this project must be delivered through publication, rather than ending at local verification.

- Unless the user explicitly limits the task to local work, complete relevant local/CI checks, merge through the protected PR flow, publish a new version and verify the public GitHub release and GHCR image/channel.
- Preserve fixed version tags. Assign the next beta version for beta fixes and verify that the beta channel resolves to the tested image.
- Keep changes within the requested scope. Track unrelated reported defects separately.
- Report release links, image/version, verification results and any remaining real-environment acceptance checks.
