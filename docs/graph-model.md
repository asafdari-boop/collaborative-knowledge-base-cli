# The knowledge graph model

Think of the vault as a library with four useful layers.

1. `Notes/` contains the books: one complete, human-readable Markdown page for every permitted Apple Note. The Apple Note's stable ID remains hidden in metadata, so a title or folder change does not create a new identity.
2. `MOCs/` contains the shelves: focused maps of content such as Investments, Startups, Frameworks & Mental Models, and Writing & Storytelling. Every present source note has one primary shelf and only genuinely useful secondary shelves.
3. `Domains/` contains the rooms: eight stable top-level areas. `Home.md` links only to those rooms, preventing a giant all-notes hub.
4. `Wiki/` contains the essays: compressed cross-note syntheses that connect several sources into a durable idea, tension, decision framework, or overview. Wiki pages are not substitutes for source notes.

The graph's edges come from four places:

- Structural edges connect Home to domains, domains to MOCs, and MOCs to first-class Notes pages.
- Explicit edges come from Apple Notes links and `>>Note title` references. Ambiguous titles are never guessed; they create a review.
- Inferred edges are sparse, rationale-bearing connections proposed by Codex and capped per source.
- Provenance edges connect Wiki syntheses back to the readable Notes pages that support them.

Obsidian's All Notes Base is an inventory, not an all-notes Markdown page. It adds no graph edges. Attachments, reviews, system files, and `.ckb` internals are excluded from the normal global graph.

## Safe editing in Obsidian

Every first-class Notes page has three visibly marked regions:

- The upstream region is the complete Apple Notes mirror. Capture changes in Apple Notes; a local edit here stops refresh rather than being silently overwritten.
- The Connections region is collaborative. CKB regenerates structural and explicit links while preserving additional human-curated links.
- The Local additions region belongs to the human and is preserved across refreshes.

Wiki pages are collaborative documents. CKB tracks a common base, merges non-overlapping human and compiler changes, and creates a review when edits overlap.

## What refresh means

Every refresh performs a complete read-only census of the configured Apple Notes scope. Stable IDs, modification timestamps, content hashes, attachment hashes, and protected-region hashes determine what changed. An unchanged refresh calls no model and rewrites no Markdown or state. A changed refresh stages normalized source pages in a disposable directory, asks Codex only for the affected graph work, validates its structured plan, and publishes the source, graph, Wiki, review, and state changes as one expected-hash transaction.

Apple Notes is always upstream and read-only. CKB never creates, edits, moves, renames, or deletes an Apple Note.
