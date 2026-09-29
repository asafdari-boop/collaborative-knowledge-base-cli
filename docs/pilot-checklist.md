# Twenty-note read-only pilot checklist

The first real-data operation is a bounded pilot into a new vault approved by the user. It is not the intended final `Knowledge` vault and it is not a full-corpus rollout.

## Stop conditions

Stop immediately if the scope is not exactly understood, the selected existing folder contains more than twenty notes, `doctor` reports a failure, the dry run shows unexpected notes, redaction is insufficient, or any command appears able to write to Apple Notes.

Do not move notes into a pilot folder merely to satisfy this checklist. Use an existing Apple Notes folder containing no more than twenty non-sensitive notes. If no suitable existing folder exists, pause and choose a different bounded selection mechanism before accessing Notes.

## Preflight

- [ ] User explicitly approves the pilot vault's absolute path.
- [ ] Confirm that the path is new and is not the intended final private vault.
- [ ] Confirm current Apple Notes/iCloud recovery or backup options.
- [ ] Select one existing folder containing at most twenty notes.
- [ ] Record the expected folder name and expected note count outside the vault for comparison.
- [ ] Initialize the new pilot vault first with `init --dry-run`, then `init`.
- [ ] Set `folderAllowlist` to only the exact existing pilot folder name.
- [ ] Set the exact account allowlist if the folder name is not globally unique.
- [ ] Add known sensitive note IDs/title patterns to the exclusion configuration.
- [ ] Confirm the configured model provider and understand that eligible normalized text leaves the Mac during compilation.

## Diagnostics

- [ ] Run `status`; confirm it says zero sources/pages and that it did not probe Notes.
- [ ] Run `doctor --no-notes-probe`; resolve binary, state, recovery, and credential failures.
- [ ] Run `doctor`; confirm the read-only account probe sees every configured account.
- [ ] Confirm no workspace lock or pending review exists.
- [ ] If `doctor` reports a prepared operation, run `recover` and re-run all diagnostics before continuing.

## Full dry run

- [ ] Run `refresh --dry-run` and save the JSON output for comparison.
- [ ] Confirm the reported note count is the expected count and never exceeds twenty.
- [ ] Inspect every warning, exclusion, inaccessible note, redaction, attachment, and missing-upstream count.
- [ ] Confirm every planned source belongs to the intended account/folder.
- [ ] Confirm no unexpected source title or attachment path appears.
- [ ] Confirm no live file exists under `Sources/Apple Notes`, `Wiki`, or `Reviews` after the dry run.
- [ ] Run `diff` a second time and confirm it remains a plan-only operation.

## First publication

- [ ] Run one real `refresh` only after the dry-run output is approved.
- [ ] Confirm the published source count matches the approved dry run.
- [ ] Open the pilot vault in Obsidian.
- [ ] Read all generated source stubs/pages and verify exclusions and redactions manually.
- [ ] Open every compiled Wiki page and spot-check every citation against its generated source.
- [ ] Confirm attachments open and internal source links resolve.
- [ ] Confirm Apple Notes titles, folders, bodies, and note counts are unchanged.

## Idempotency and collaboration

- [ ] Run a second dry run with no Apple Notes changes.
- [ ] Confirm all source and wiki files are reported as no-ops and no new reviews appear.
- [ ] Make a harmless human edit to one `Wiki/` page in Obsidian, never to `Sources/`.
- [ ] Dry-run refresh and confirm a non-overlapping compiler edit would merge without removing the human edit.
- [ ] Use synthetic tests—not a valuable real page—to verify the overlapping-edit review workflow.
- [ ] Approve or reject any pilot reviews and confirm the audit record is archived.

## Full-corpus decision gate

- [ ] User reviews the pilot vault and the saved dry-run/doctor reports.
- [ ] Document unsupported accounts, inaccessible/locked notes, redaction misses, attachment failures, and linking quality.
- [ ] Decide whether to adjust allowlists, exclusions, redaction patterns, compiler instructions, or wiki organization.
- [ ] Obtain separate explicit approval before creating the final vault or widening extraction to the full Notes corpus.

Passing the pilot validates the pipeline and its operational boundaries. It does not authorize Apple Notes writes or a full-corpus rollout.

If the user separately approves a full-corpus disposable candidate, preserve every safety check above while replacing the small-folder requirement with an exact active-note census, an explicit `maximumNoteCount`, a verified copied `databasePath` when available, and a local `audit` before compilation. The candidate must use a new path and must not be treated as the permanent vault merely because it compiled successfully.
