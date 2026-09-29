# Apple Notes Exporter integration

CKB uses [kzaremski/apple-notes-exporter](https://github.com/kzaremski/apple-notes-exporter) as an external, read-only extraction dependency. Version 2 provides the `notes-export` CLI, JSON listing commands, Markdown export, attachments, and an incremental manifest.

## Installation and permission

Download the current v2 release from the project's [GitHub releases](https://github.com/kzaremski/apple-notes-exporter/releases). Ensure the bundled `notes-export` executable is available on `PATH`, or put its absolute path in the vault's `.ckb/config.json`:

```json
{
  "extractor": {
    "executable": "/absolute/path/to/notes-export",
    "databasePath": "/absolute/path/to/copied/group.com.apple.notes/NoteStore.sqlite",
    "accountAllowlist": ["iCloud"],
    "folderAllowlist": ["Existing Pilot Folder"],
    "noteIdAllowlist": [],
    "maximumNoteCount": 20,
    "timeoutMs": 300000
  }
}
```

The exporter requires Full Disk Access to read the live system Notes database. CKB does not try to bypass macOS permissions. When `databasePath` points to an already accessible verified copy, CKB passes `--db ABSOLUTE_PATH` immediately after every database-reading subcommand instead. It never falls back from a copied database to the live database. `ckb doctor` reports permission symptoms separately from missing or incompatible binaries.

Upstream v2.0-2 resolves attachment paths from the live Notes container even when `--db` selects a copied database. It can also lose attachment reads intermittently when many notes share one repository handle during concurrent export. For a complete backup-only export, build the narrowly scoped [backup-media patch](../patches/apple-notes-exporter/README.md). It resolves attachments beside the opened database and serializes note export for deterministic completeness. CKB still rejects any run with a failed or missing attachment.

The upstream exporter documents support for iCloud and On My Mac accounts. Email-backed Notes accounts such as Gmail, Yahoo, and Outlook are not supported by its database reader. CKB fails a configured-account check when an allowlisted account is not visible; it does not silently claim complete coverage.

## Contract CKB validates

CKB invokes the binary directly without a shell and applies time/output bounds.

```text
notes-export --version
notes-export list-accounts [--db COPY] --format json
notes-export list-notes [--db COPY] --format json [account/folder scope]
notes-export export [--db COPY] --output STAGING --format markdown --incremental [account/folder scope] --notes EXACT_IDS
notes-export list-notes [--db COPY] --format json [account/folder scope]
```

A valid operation must satisfy all of these conditions:

- The binary reports major version 2.
- Account and note listings match the expected JSON schemas.
- Note IDs are unique.
- Every configured allowlisted ID is present, the selected scope is nonempty, and its count does not exceed `maximumNoteCount`.
- The pre-export and post-export note censuses have the same IDs, modification dates, accounts, and folders.
- The export reports no failed notes or attachments.
- The incremental manifest maps every selected note ID to one confined Markdown path.
- A manifest entry outside the exact selected ID set is rejected.
- Every declared attachment exists, has the expected size, and stays inside staging.
- No symlink or path traversal can escape staging or the vault.

Any failed condition stops the refresh before live publication.

## Stable identity and links

The exporter's filenames and folder layout are inputs, not identity. CKB hashes the stable Apple Notes note ID internally while assigning a human-readable filename from the note title. Duplicate titles are disambiguated by readable folder name and, only when still necessary, a short stable suffix. Renaming a note moves the generated page transactionally, preserves safe aliases, and retains the same internal source identity. Secret-like title metadata is redacted before filename allocation.

Internal links are resolved from the export manifest and rewritten to stable source wikilinks. CKB does not guess links from duplicate titles. Attachments are renamed by content hash.

Refresh also removes obsolete generated duplicates left by a prior readable-path migration when—and only when—the file identifies a currently tracked Apple Note and contains no human-only Local additions or curated Connections. Unrecognized Markdown files are left untouched.

## Raw export retention

The exporter creates Markdown before CKB applies exclusions and secret redaction. For that reason CKB does not promote the raw export directory into the vault, even though the upstream exporter supports persistent incremental caches. Each CKB refresh uses disposable local staging and removes it afterward.

This favors confidentiality and simple recovery over incremental extraction speed. A future encrypted raw cache would need an explicit threat model and migration plan before it could be enabled.

## Read-only boundary

CKB calls only listing and export operations. It does not call an Apple Notes create, update, move, rename, or delete operation. No CKB transaction targets the Notes database or Notes.app.

Before model compilation, `ckb audit` can run the same extraction, local secret redaction, normalization, and attachment planning without publishing or invoking a model. Its output is aggregate-only so it can be retained as an operational coverage report.
