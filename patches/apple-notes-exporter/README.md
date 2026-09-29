# Apple Notes Exporter backup-media patch

The official Apple Notes Exporter v2.0-2 `--db` option reads a copied
`NoteStore.sqlite`, but its attachment resolver still searches the current
user's live `group.com.apple.notes` container. That produces a successful note
export with missing attachments when the process intentionally lacks Full Disk
Access.

`v2.0-2-backup-media.patch` makes the attachment resolver use the parent
directory of the database that was actually opened. It also serializes note
export because the shared Notes repository/database handle intermittently loses
attachment reads under concurrent full-corpus export. The default live-database
path behavior is unchanged; export is intentionally slower in exchange for a
deterministic attachment census.

The patch applies to upstream tag `v2.0-2` at commit
`c0ddf926eabcea679286a32f897a22a4f01c1e25`. The upstream project remains GPLv3
and is not vendored here.

## Build

```sh
git clone https://github.com/kzaremski/apple-notes-exporter.git
cd apple-notes-exporter
git checkout --detach v2.0-2
git apply /absolute/path/to/v2.0-2-backup-media.patch

xcodebuild -resolvePackageDependencies \
  -packageAuthorizationProvider netrc \
  -project "Apple Notes Exporter/Apple Notes Exporter.xcodeproj"

xcodebuild \
  -project "Apple Notes Exporter/Apple Notes Exporter.xcodeproj" \
  -scheme notes-export \
  -configuration Release \
  -destination "platform=macOS,arch=arm64" \
  -packageAuthorizationProvider netrc \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Before configuring CKB to use the resulting executable, validate it against a
copied container containing at least one note with attachments. The export must
report `failed: 0` and `failedAttachments: 0`, and the attachment files must
exist under the export directory.
