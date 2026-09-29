# Security

Report security issues privately to the repository owner. Do not include real note content, credentials, private filesystem paths, database files, or vault artifacts in an issue, pull request, screenshot, or reproduction.

If a credential is committed or disclosed, rotate it immediately. Removing it from the latest commit is not enough because Git history and forks may retain it.

CKB is local-first, but it coordinates several trust boundaries:

- Apple Notes extraction
- Local normalization and secret redaction
- Model-backed compilation
- Obsidian vault publication
- Recovery state and backups

Reports should identify which boundary is affected and whether the issue could expose source text, bypass configured exclusions, overwrite human edits, escape staging, or publish a partial transaction.

Security issues in Apple Notes Exporter, Codex, a model provider, Obsidian, or another dependency may need to be reported to that upstream project as well.
