# Collaborative Knowledge Base

This project turns Apple Notes into a private Markdown knowledge base that humans, Obsidian, and agents can share safely.

This repository contains the CKB engine, not a user's vault. Vault contents, Apple Notes exports, databases, attachments, media, transcripts, credentials, and `.ckb` runtime state belong outside the source repository and must remain private.

Apple Notes remains the canonical capture layer. CKB reads Notes through an external exporter, generates stable Markdown source files, compiles an interlinked wiki in isolation, and publishes only after validation. It never writes, moves, renames, or deletes an Apple Note.

## Vault model

```text
Knowledge vault/
  Home.md                eight-domain entry point
  Domains/               stable top-level areas
  MOCs/                  focused maps of content
  Notes/                 complete first-class Apple Notes pages
  Attachments/           content-addressed exported attachments
  Wiki/                  compressed cross-note synthesis
  Views/                 dynamic inventories that add no graph edges
  Reviews/               visible merge-conflict review pages
  .ckb/                  private state, revisions, journal, and compiler cache
```

There is one shared wiki page, not separate human and agent copies. Each page has a stable `ckb_id`. CKB remembers the last shared revision and performs a three-way merge:

- Non-overlapping human and compiler edits merge automatically.
- Overlapping edits leave the human page untouched and create a pending review.
- Direct agent edits require the exact live-page hash.
- Moving a tracked `Wiki/` page in Obsidian preserves its `ckb_id`; CKB records the old path as an alias after confirming the original no longer exists.
- Readable filenames are separate from stable Apple Note identities, so title or folder changes do not create a different note.

See [The knowledge graph model](docs/graph-model.md) for how Home, domains, MOCs, first-class source pages, Wiki syntheses, and graph edges fit together.

## Safety guarantees

- Every refresh is planned before any live file changes.
- `refresh --dry-run` performs extraction, normalization, compilation, validation, and reconciliation without changing Sources, Wiki, Reviews, state, objects, or durable caches.
- A partial Notes export or compiler failure publishes nothing.
- Sources, attachments, wiki pages, review records, and state publish in one expected-hash transaction. Interrupted writes are rolled back.
- Before the first file swap, CKB fsyncs preimage objects and a prepared recovery record. `ckb recover` restores a hard-terminated operation; it refuses to overwrite an unrelated newer edit.
- Apple Notes disappearance creates recoverable state; CKB does not delete the last generated source.
- Human edits to a Notes page's protected upstream region stop refresh instead of being overwritten. Human Connections and Local additions are preserved.
- Secret-like values are redacted before compiler-eligible text is staged. Explicitly excluded and inaccessible notes are represented by safe stubs and are not sent to the compiler.

No safeguard replaces a backup. Keep Apple Notes/iCloud backup and vault backup policies appropriate to the material.

## Prerequisites

- macOS and Node.js 24 or newer
- pnpm
- [Apple Notes Exporter v2](https://github.com/kzaremski/apple-notes-exporter) with the `notes-export` executable available
- Full Disk Access for the exporter when the live system Notes database is read; copied-database mode can use an already accessible verified backup instead
- The local Codex executable with an existing ChatGPT subscription login

Apple Notes Exporter is an external GPL-licensed program and is not vendored into this project. `llm-wiki-compiler` is installed as a pinned package dependency.

## Setup

```sh
pnpm install
pnpm build
node dist/cli/main.js init --vault "/absolute/path/to/Pilot Vault" --dry-run
node dist/cli/main.js init --vault "/absolute/path/to/Pilot Vault"
```

Edit `.ckb/config.json` inside the initialized vault to set exact Apple Notes account/folder allowlists, a hard count ceiling, optional stable note IDs, sensitivity exclusions, and—when operating from a verified backup—the copied database path:

```json
{
  "extractor": {
    "executable": "/absolute/path/to/notes-export",
    "databasePath": "/absolute/path/to/copied/NoteStore.sqlite",
    "accountAllowlist": ["iCloud"],
    "folderAllowlist": ["Notes"],
    "noteIdAllowlist": [],
    "maximumNoteCount": 10000,
    "timeoutMs": 3600000
  },
  "compiler": {
    "primary": {
      "adapter": "codex-agent",
      "executable": "/Applications/ChatGPT.app/Contents/Resources/codex",
      "model": "gpt-5.6-sol",
      "reasoningEffort": "high"
    },
    "fallback": {
      "adapter": "llmwiki",
      "provider": "claude-agent"
    },
    "fallbackPolicy": "manual",
    "concurrency": 3
  }
}
```

An empty `noteIdAllowlist` means every note inside the exact account/folder intersection, never more than `maximumNoteCount`. A nonempty list selects those stable IDs exactly and handles duplicate titles safely. Codex uses the user's saved ChatGPT login; no API key is required. The fallback is manual only and is selected only with `refresh --use-fallback`. Use a bounded [pilot checklist](docs/pilot-checklist.md) unless the user has explicitly approved a full-corpus staged rebuild.

```sh
node dist/cli/main.js status --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js doctor --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js audit --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js upstream-diff --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js refresh --vault "/absolute/path/to/Pilot Vault" --dry-run
node dist/cli/main.js diff --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js refresh --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js query --vault "/absolute/path/to/Pilot Vault" "What themes recur in my investment thinking?"
node dist/cli/main.js recover --vault "/absolute/path/to/Pilot Vault"
```

`status` reads only local vault state. `doctor` checks the exporter, provider credentials, state integrity, recovery locks, and reviews; unless `--no-notes-probe` is used, it also performs a read-only account-metadata probe against the configured live or copied database. `audit` performs extraction, local sensitivity processing, and normalization but invokes no model and publishes nothing; its JSON contains aggregate counts rather than bodies, titles, or raw stable IDs.

`upstream-diff` reports new, changed, and missing Apple Notes by hashed stable identity after comparing upstream content, attachment, and metadata hashes. Its JSON identifies whether the configured source is the live Notes database or a copied database. It invokes no model and changes neither Apple Notes nor the vault. By contrast, `diff` is a complete dry-run refresh: it also predicts downstream graph and Wiki changes, so it invokes Codex when the incremental manifest is not a no-op. `refresh` validates and publishes the complete plan.

For a full-corpus rebuild, use a timestamped staging path such as `/absolute/path/to/Knowledge-Rebuild-YYYY-MM-DD`. Follow [Rebuild and recovery](docs/rebuild-and-recovery.md); never build directly over the permanent vault.

## Obsidian and agents

Open the vault root directly in Obsidian. Edit `Wiki/` pages normally. In `Notes/`, use the Connections and Local additions regions; capture upstream content changes in Apple Notes. Do not edit `Attachments/` or `.ckb/`.

Before an agent writes a wiki page, it should read the page, preserve its `ckb_id`, and submit the exact current hash. Compiler updates use the same merge and review rules. Safe agent access is intentionally limited to the collaboration service; direct filesystem write access to the vault should not be granted as a substitute.

```sh
node dist/cli/main.js page read "Wiki/Page.md" --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js page create "Wiki/New Synthesis.md" \
  --vault "/absolute/path/to/Pilot Vault" \
  --content-file "/absolute/path/to/new-synthesis.md" \
  --source "Notes/Source One.md" "Notes/Source Two.md"
node dist/cli/main.js page patch "Wiki/Page.md" \
  --vault "/absolute/path/to/Pilot Vault" \
  --expected-hash CURRENT_SHA256 \
  --content-file "/absolute/path/to/proposal.md"
```

New Wiki syntheses must declare their readable source-note provenance and link every declared source in the page. CKB records the source hashes, tracks the page immediately, and updates the incremental compiler baseline. Agents cannot use this surface to create untracked pages or patch stale content. Existing manual Wiki pages are first adopted with a stable ID while preserving their human content; compiler edits begin on a later refresh with a recorded base.

Review commands:

```sh
node dist/cli/main.js review list --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js review show REVIEW_ID --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js review approve REVIEW_ID --vault "/absolute/path/to/Pilot Vault"
node dist/cli/main.js review reject REVIEW_ID --vault "/absolute/path/to/Pilot Vault"
```

## Data-egress boundary

Apple Notes extraction happens locally in a disposable staging directory. Normalization and redaction happen before compilation. During Codex compilation, compiler-eligible normalized source text is processed through the user's configured Codex/ChatGPT session. Excluded, inaccessible, locked, missing-upstream, and detected secret content is not sent as source text.

CKB deliberately does not retain the exporter's raw Markdown cache because it precedes sensitivity filtering. It retains only the normalized first-class Notes layer and private compiler state. Temporary extraction and compiler directories are removed after each run.

See [Apple Notes Exporter integration](docs/apple-notes-exporter.md) for the exact contract and limitations.

## Development verification

```sh
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

All automated tests use synthetic notes. Real Apple Notes and the intended final private vault are outside the automated test scope.

## Project documentation

- [Architecture](docs/architecture.md)
- [Apple Notes Exporter integration](docs/apple-notes-exporter.md)
- [Rebuild and recovery](docs/rebuild-and-recovery.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT License](LICENSE)
