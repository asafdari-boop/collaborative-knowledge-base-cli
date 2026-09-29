# Rebuild and recovery

## Safe rebuild sequence

1. Close Notes.app and copy the complete `group.com.apple.notes` container as one unit, including `NoteStore.sqlite`, WAL, SHM, media, drawings, and previews. Verify SQLite integrity, archive integrity, and file checksums.
2. Initialize a new staging vault at a different path. Point its extractor at the verified copied database, remove pilot note-ID limits, and retain an explicit maximum larger than the full census.
3. Run `ckb audit` locally. Reconcile permitted, excluded, inaccessible, attachment, redaction, and warning counts before any model call.
4. Run a complete `ckb refresh --rebuild` in the staging vault. Validate assignments, readable links, Wiki provenance, MOC size limits, graph metrics, and the absence of hash-style page names.
5. Run an unchanged refresh and prove it is a byte-for-byte no-op. Run representative read-only queries and inspect Home, every domain, representative MOCs, Notes pages, Wiki pages, backlinks, and graph views in Obsidian.
6. Close Obsidian. Hash the current permanent vault, copy or move it into a timestamped protected backup, and verify that backup before replacing the permanent path with the staging vault.
7. Reopen the permanent path, repeat status/link/no-op checks, and retain both the Apple Notes backup and old vault backup.

Never build directly over the permanent vault. Never replace individual live Apple Notes database files. Never delete a backup as part of promotion.

## Operational commands

```sh
ckb status --vault "/absolute/path/to/Knowledge"
ckb doctor --vault "/absolute/path/to/Knowledge"
ckb audit --vault "/absolute/path/to/Knowledge-Rebuild"
ckb refresh --vault "/absolute/path/to/Knowledge-Rebuild" --dry-run --rebuild
ckb refresh --vault "/absolute/path/to/Knowledge-Rebuild" --rebuild
ckb rebuild --vault "/absolute/path/to/Knowledge" \
  --staging "/absolute/path/to/Knowledge-Rebuild" \
  --backup-root "/absolute/path/to/Backups/Knowledge" \
  --seal-only
ckb rebuild --vault "/absolute/path/to/Knowledge" \
  --staging "/absolute/path/to/Knowledge-Rebuild" \
  --backup-root "/absolute/path/to/Backups/Knowledge" \
  --promote
ckb query --vault "/absolute/path/to/Knowledge" "What themes recur in my investment thinking?"
ckb recover --vault "/absolute/path/to/Knowledge"
ckb rollback --vault "/absolute/path/to/Knowledge" \
  --backup "/absolute/path/to/Backups/Knowledge/TIMESTAMP/Knowledge" \
  --recovery-root "/absolute/path/to/Backups/Knowledge/Rollbacks"
```

`recover` is for an interrupted atomic CKB publication. `rollback` is for reversing a completed rebuild promotion: it verifies the original promotion receipt and backup manifest, restores the entire previous vault atomically, and moves the displaced rebuilt vault into a dated recovery directory instead of deleting it.

## Authentication

The Codex compiler and query command use the local Codex executable and the user's existing ChatGPT subscription login. No API key is stored in the vault. The llmwiki/Claude configuration is manual fallback only and is never selected automatically.
