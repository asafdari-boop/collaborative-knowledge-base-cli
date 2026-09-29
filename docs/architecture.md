# Architecture

Collaborative Knowledge Base turns a bounded Apple Notes corpus into a Markdown knowledge graph without treating generated text as more trustworthy than the sources or allowing a failed run to partially rewrite the vault.

## Pipeline

1. **Read-only extraction.** CKB invokes Apple Notes Exporter through a direct process boundary. Account, folder, stable-ID, and count limits define the permitted corpus. Pre- and post-export censuses detect an unstable extraction.
2. **Normalization and screening.** Exported Markdown is staged locally. Paths are confined, attachments are verified, secret-like values are redacted, excluded material becomes a safe stub, and stable source identities are separated from readable filenames.
3. **Isolated compilation.** Only compiler-eligible normalized material enters a disposable compiler workspace. The model proposes a structured graph plan and Wiki changes; it cannot publish directly.
4. **Validation.** CKB validates identities, paths, provenance, taxonomy assignments, relationship limits, internal links, and page schemas before any live write.
5. **Collaboration merge.** Wiki pages share one human-agent version. CKB compares the recorded base, the current human page, and the proposed page. Non-overlapping edits merge; overlapping edits create a review and leave the human page unchanged.
6. **Atomic publication.** Source pages, graph pages, Wiki pages, reviews, and state are applied through expected-hash transactions. A prepared recovery record preserves preimages before the first swap.
7. **Recovery.** Interrupted publications can be recovered without overwriting an unrelated newer edit. Full-vault rebuild promotion uses verified staging and backup directories rather than writing over the permanent vault.

## Stable identity and readable paths

An Apple/Core Data identifier is hashed into CKB's stable source identity. Human-readable Markdown paths are allocated from note titles, with folder and short stable suffixes used only to resolve collisions. Renaming or moving a note therefore changes its readable path without changing its identity.

Every managed Wiki page has a stable ckb_id independent of its filename. This lets humans rename pages in Obsidian while incremental refresh still recognizes the page.

## Graph layers

- Home links to broad domains.
- Domains link to focused maps of content.
- Maps of content link to first-class source-note pages.
- Wiki pages synthesize several sources and link back to their evidence.
- Explicit source links and sparse reviewed inferences add cross-topic relationships.

The graph is designed for retrieval and navigation rather than maximum edge density.

## Data boundary

This source repository contains the engine and synthetic fixtures only. A user's Notes database, raw exports, normalized vault, attachments, media, transcripts, credentials, backups, reviews, object store, compiler cache, and operation journal remain private local data.

The .gitignore rules help prevent accidental inclusion, and the public-tree audit rejects known private-data patterns. Neither replaces careful review before publication.
