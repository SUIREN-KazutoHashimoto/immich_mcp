# Vault maintenance

These commands maintain the MCP server's encrypted local store. They are separate from Immich's API backup/restore operations. No production environment has been configured or changed.

## Storage and keys

The application uses schema version 2. Records authenticate their principal, ID, kind, fixed upstream identity and key-version UUID. Originals identify their authenticated cipher format and key version. A wrong key, mismatched storage identity or unknown schema is rejected.

Opening a version-1 application store migrates metadata in one SQLite transaction. Original files retain their old cipher format until a full rekey. A late authentication failure rolls back the migration. Take an offline backup before upgrading: the backup command can read schema 1 without migrating the source.

Keep the service stopped through backup, copying, verification and activation. Commands take storage ownership and a consistent database view and refuse a live application. Keep only one application instance active. Source and destination must not overlap; the destination must not exist and its parent must exist. Use native absolute paths, such as C:/data/immich-mcp-backup on Windows.

Keep the 32-byte master-key file outside both the data directory and backup directory, and recover it through a separate protected route. The backup/restore CLI checks the resolved key-file location. No key material appears in command output or manifests. A lost master key cannot be regenerated to decrypt existing data.

The CLI reads the fixed IMMICH_BASE_URL. Backup and rekey also read STORAGE_PATH, optional DATABASE_PATH and VAULT_MASTER_KEY_FILE. Offline commands do not need Cloudflare settings. Restore and verify use the explicitly supplied backup key; the active generation's key need not exist.

## Make an offline backup

Build the maintenance tool before stopping the service:

```sh
pnpm build
```

Stop the application, then create and verify a new archive:

```sh
node --env-file=.env dist/scripts/vault.js backup --to /absolute/backups/immich-mcp-2026-11-09
node --env-file=.env dist/scripts/vault.js verify --directory /absolute/backups/immich-mcp-2026-11-09 --key /absolute/private/immich-mcp-master.key
```

Success returns backup_complete. Backup includes the main database even when DATABASE_PATH is outside STORAGE_PATH, its owner database and every generated original file. It preserves encrypted records and original reference IDs, expiry times, partial/empty originals, resumable upload chunks and durable job evidence. Source schema and ciphertext are not migrated or rewritten. Missing or corrupt referenced originals fail before creating a destination.

Generated orphan originals are copied as opaque ciphertext rather than deleted. The output reports preserved_orphans; an orphan cannot be authenticated as plaintext without its lost metadata. This also permits a read-only backup when an owner binding is missing, without adopting unknown originals into the source. Unrelated files, .env and separately stored master keys are excluded.

Each archive has a fresh storage identity, authenticated backup ID, encrypted backup-only role and .backup-only marker. New archives use SQLite DELETE journaling so read-only inspection does not create unsigned WAL/SHM files. It is recovery input, not an application data directory. Removing its marker does not make the application accept it. The source remains unchanged and available.

The archive remains .maintenance-incomplete until copies, full decryption/integrity checks and the authenticated manifest finish. Failed candidates are retained for diagnosis, never overwritten or automatically activated. Keep an off-host copy of the verified immutable archive and protect its separate key. Use the explicit retention plan/apply workflow below to prune verified archives; do not remove the only verified recoverable generation.

## Plan and apply backup retention

Use a dedicated backup collection directory writable only by its operator. Retention scans its immediate child directories, not arbitrary nested paths. Keep the master key and saved plan outside that collection. No production retention run has been performed by the development tests.

Create a plan that retains the newest three independently identified archives authenticated by the supplied key and fixed upstream:

```sh
node --env-file=.env dist/scripts/vault.js retention-plan --directory /absolute/backups/immich-mcp --keep 3 --key /absolute/private/immich-mcp-backup.key --out /absolute/private/retention-plan.json
```

The output lists each eligible archive with its keep/delete action, creation time, physical directory identity, backup ID, file count and bytes. It also lists skipped entries and reasons. Planning does not delete archives. The plan file is created without overwriting an existing file and is authenticated separately from backup manifests. Inspect the listed actions, then apply that exact plan:

```sh
node --env-file=.env dist/scripts/vault.js retention-apply --directory /absolute/backups/immich-mcp --plan /absolute/private/retention-plan.json --key /absolute/private/immich-mcp-backup.key
```

Keep must be 1–1000; the collection limit is 1000 entries. Newest is determined by the authenticated creation time, with directory names breaking ties. Future-dated archives, duplicated backup IDs, case-colliding directory names, another upstream/key, application/rekey/restore generations, unfinished archives and directories containing unrelated files are preserved and reported. The policy applies to eligible archives for this supplied key; backups using other keys are not counted or removed.

The archive must have exactly its signed databases/originals, manifest and recognized backup marker. Symlinks, junctions, unexpected subdirectories, unsigned auxiliary database files and operator notes block deletion. Older archives that retain empty WAL/SHM files remain restorable but are skipped by retention rather than having those files silently discarded.

Apply authenticates the plan, checks physical root/archive identities and revalidates all retained and deletion candidates before the first removal. If a retained backup changed or disappeared, the plan stops. New archives added after planning are untouched. Creating a new plan is necessary when the approved set changes; copying files into a replacement directory does not satisfy the old physical identity.

Deletion takes an OS-backed collection lock, moves an approved archive into a .retention-deleting-* directory and writes a flushed, separately authenticated deletion intent. It removes only the enumerated files after rechecking their hashes; it does not recursively delete a directory. Unexpected files are preserved. Collection paths and directory identities are checked again during deletion.

If interrupted, retain the original plan and run the same retention-apply command again. It recognizes its moved/partially removed archive, verifies every remaining file and resumes. Already removed archives are reported separately. Do not delete quarantine directories, intent files or the plan to force progress. A changed file or an unexpected operator note requires diagnosis first. The newest retained archives remain subject to validation on every retry. Concurrent retention operations are rejected by the OS lock, which is released if the process dies.

Successful output reports retention_applied, removed, already_absent and retained. The operation never deletes an unverifiable archive merely to reach the requested count. It does not replace a separate protected/off-host recovery copy or power-loss validation.

## Restore or recover an earlier snapshot

Stop the current application and retain its data and key for diagnosis. Restore into another new directory:

```sh
node --env-file=.env dist/scripts/vault.js restore --from /absolute/backups/immich-mcp-2026-11-09 --to /absolute/data/immich-mcp-recovered --key /absolute/private/immich-mcp-backup.key
node --env-file=.env dist/scripts/vault.js verify --directory /absolute/data/immich-mcp-recovered --key /absolute/private/immich-mcp-backup.key
```

The supplied key is the archive's original key, which may differ from the active service's key. Keep IMMICH_BASE_URL identical to the archived configuration. Restore authenticates the archive and inventory before creating a destination, checks every file while copying and decrypts all retained records/originals again. Nonempty SQLite WAL/journal files are rejected because their state is outside the signed main-file hash. The archive is never activated or modified.

Restore returns ready_for_activation and recovery counts. It creates a fresh storage identity and normalizes a legacy copy to the current schema. It preserves reference IDs and expiry times. Unexpired local upload chunks can resume; restoring does not extend their lifetime. It does not restore Immich itself or undo any upstream operation.

Every queued, running or cancel-requested snapshot job becomes outcome_unknown, including jobs whose stored send marker was false. Such work may have run after the backup was taken, so none is automatically replayed. The diagnostic preserves the snapshot marker and explicitly says later effects are unknown. Check upstream state before submitting a new operation. Completed and other terminal jobs retain their snapshot state.

All additional authentication contexts are disabled with a new generation; their active credentials, cookie jars and OAuth state are cleared. Callback references are marked used and the OAuth-state index is emptied. Connect required contexts again explicitly. Normal API-key bindings remain registered; a key rotated or deleted in Immich since the backup will need replacement through /connect. The connection screen explains the recovery state without exposing other users' recovery counts.

Job quarantine, context invalidation, removal of the backup role and the new database identity commit together, after all signed files are copied. A failed candidate stays marked incomplete. In-process failures or process death do not activate it.

## Rotate the master key

With the service stopped, create a different key at an absolute path outside the data directories:

```sh
pnpm keygen /absolute/private/immich-mcp-next.key
node --env-file=.env dist/scripts/vault.js rekey --to /absolute/data/immich-mcp-next --new-key /absolute/private/immich-mcp-next.key
node --env-file=.env dist/scripts/vault.js verify --directory /absolute/data/immich-mcp-next --key /absolute/private/immich-mcp-next.key
```

Rekey creates a separate verified generation and reencrypts every retained record/original, including expired metadata, partial transfers and empty files. It preserves reference IDs, binding revisions and job states, assigns fresh key/storage versions and checks original plaintext sizes/hashes and GCM authentication. It never overwrites or deletes the source. Missing originals or unresolved generated orphans block rekey before creating a destination; diagnose those using the original generation.

Unlike snapshot recovery, a rekey preserves the current job queue. After the new generation has processed work, do not directly restart the old generation: it can replay work queued in the old copy. Take an offline backup of the retained generation and use the restore command's quarantine workflow when recovering an older state.

## Activate or roll back

Keep the service stopped and verify the chosen new generation before changing all three settings together:

```dotenv
STORAGE_PATH=/absolute/data/immich-mcp-recovered
DATABASE_PATH=/absolute/data/immich-mcp-recovered/vault.sqlite
VAULT_MASTER_KEY_FILE=/absolute/private/immich-mcp-backup.key
```

An omitted DATABASE_PATH uses STORAGE_PATH/vault.sqlite. Start one instance, check readiness and the authenticated /connect screen. Verify normal key registration and reconnect additional contexts as needed. Keep the previous generation and its separate key until recovery checks and the chosen retention period finish.

For a failed deployment, stop it and recover a verified pre-update archive into a fresh directory using the restore procedure. Use application code that supports the recovered storage schema. The current tool restores legacy backups into schema 2; it does not downgrade storage for an older schema-1 binary. Reverting a binary without checking schema compatibility is not a supported rollback. Restoring MCP state cannot reverse upstream Immich changes.

## Immich API-key self-rotation and recovery

This is the user's Immich API key lifecycle, separate from the MCP vault master key. rotateApiKey targeting the caller's active key commits the new registered secret, its saved result and an asynchronous job's terminal receipt together in one SQLite transaction. The job retains the credential revision used at acceptance; only its proven self-rotation result moves to the exact next binding revision.

Other old jobs/results remain invalid after the update. Replacing or disconnecting the binding later also invalidates the rotation receipt. A session-originated rotation requires the explicitly acknowledged general-session workflow and a verified owner. Its receipt transfers to the same normal API-key binding; the old context stays paused until revalidated or reconnected. This does not inherit API-key permissions into the session or enable automatic fallback.

Large or encoded valid responses are inspected through their saved schema-validated projection. A large name/permissions payload does not prevent extracting the current key ID and generated secret within the configured inspection limits. API-key UUID identity comparisons accept hexadecimal case differences; credential secrets and opaque references remain exact strings.

Until the local transaction commits, the saved display is outcome_unknown with rotation_recovery_required. A failed key/result/job write inside that transaction rolls back the binding transition. A later duplicate receipt-write failure preserves the already committed completion. It does not undo a rotation already performed by Immich. Process death after the local commit preserves the new key, result and completed job without replay.

If rotation_recovery_required is reported:

1. Do not repeat rotateApiKey automatically. Inspect the job/request ID and the authenticated /connect screen's recent result.
2. While the original binding/result remains available, use its protected original download to preserve the upstream response. The original can contain the newly generated key. Keep that material out of chat and normal MCP arguments; encoded originals retain their documented content coding.
3. Register the recovered key through the connection form, which validates it using getMyApiKey before replacing the binding. If the original is unavailable, recover/create a usable key through Immich's own account interface, then register it explicitly.
4. Reconnect or revalidate additional contexts as required. Check upstream state before deciding whether another operation is needed.

A concurrent binding replacement is never overwritten by a late rotation response. A different returned key ID is not adopted. The pending result stays uncertain rather than claiming success; later binding changes continue to protect older cached data. Offline backup verification and retention do not replay uncertain rotations.

## Manifest, durability and evidence limits

manifest.json records schema/cipher/key versions, archive/source identities, creation time and exact database/original-file sizes and SHA-256 hashes. HMAC-SHA-256 authenticates the inventory using an HKDF-derived key separate from record encryption. SQL job state is covered by the database-file hash. Verification rejects unexpected generated objects, duplicate/case-colliding paths, traversal and incomplete database inventories without opening the database.

The offline limit is 32 MiB of manifest and 100,000 originals. Transfers are streamed and copied bytes are hashed again. Files are flushed before completion; SQLite uses FULL synchronization. On supported Unix filesystems the containing directories are also synchronized. Windows directory synchronization, OS/power-loss behavior and container-volume durability remain unverified. A successful process-death test is not power-loss validation.

The immutable manifest describes the completed offline generation. Normal application writes change its hashes; a later verify failure on an already active generation does not by itself establish corruption. Make a new offline backup to obtain a new signed inventory.

Local tests cover legacy snapshots without source migration, multiple principals, expired/partial/empty originals, opaque orphans, upload resumption, job quarantine, context/OAuth invalidation, wrong keys, corruption, path/WAL rejection, separate source databases, actual CLI commands and killed child processes during copying/re-encryption. See DEVELOPMENT.md for current results. Container deployment, the full operational readiness contract and live Immich/Cloudflare/ChatGPT acceptance remain open.
