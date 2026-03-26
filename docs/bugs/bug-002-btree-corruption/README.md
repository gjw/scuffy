# BUG-002: SQLite B-tree corruption — "cursor must be on a leaf to delete"

## Date

2026-03-26

## Versions

- br: 0.1.20 (bundled rusqlite with SQLite 3.52.0)
- System sqlite3: 3.51.0 (macOS) / 3.50.6 (Android SDK)
- Node: 24.13.1
- macOS: Darwin 25.3.0

## Symptoms

- `br update <id> --claim` fails with:
  ```
  DATABASE_ERROR: cursor must be on a leaf to delete
  ```
- `br list --json` works (reads succeed)
- `br doctor` reports `schema.tables: Missing tables` but `sqlite.integrity_check: OK`
- `br init --force` recreates the DB but the error persists
- System `sqlite3` reports "database disk image is malformed"

## Context

This occurred after a long build session (~20+ bead completions, ~10 Tower
replans, many br create/close/update operations over ~3 hours). The DB worked
fine for the first ~15 beads, then started failing on write operations.

## Header analysis

```
file_size: 1,363,968 bytes
page_size: 4,096
db_size_pages_header: 1    ← WRONG (should be 333)
actual_pages: 333
change_counter: 0          ← never incremented
schema_cookie: 0           ← never set
sqlite_version_written: 3052000
```

The header claims 1 page but the file is 333 pages. The change counter and
schema cookie are both 0, suggesting the header was never updated after initial
creation. This is the same header corruption pattern as BUG-001.

## Root cause hypothesis

The bundled SQLite 3.52.0 in rusqlite writes data to pages correctly (reads
work, 82 records accessible) but does not properly maintain the file header
or B-tree structure across many write operations. The "cursor must be on a
leaf to delete" error suggests B-tree node corruption — an internal node
points to a location that isn't a leaf, so DELETE/UPDATE operations fail.

This may be:
1. A WAL checkpoint bug in the bundled SQLite version
2. A rusqlite binding issue with SQLite 3.52.0
3. Accumulated damage from many rapid write/flush cycles

## Impact

- Cannot claim, update, or close beads (all writes fail)
- Reads continue to work (br list, br show)
- bv reads from JSONL and works, but recommends beads that br can't claim
- The workspace is effectively stuck until the DB is rebuilt

## Workaround

Delete the SQLite DB and reinitialize:
```bash
rm .beads/beads.db && br init
```

br reimports from the JSONL file, which is the durable source of truth.

## Files in this directory

- `beads.db` — the corrupted database file
- `issues.jsonl` — the JSONL export (source of truth, intact)
- `config.yaml` — beads configuration
- `br-version.txt` — br version output
- `br-doctor.txt` — br doctor output
- `claim-error.txt` — the exact error from br update --claim
- `header-analysis.txt` — parsed SQLite header showing corruption

## Third occurrence (2026-03-26, evening)

Same error recurred during a fresh rebuild run (~30+ bead completions, ~15 Tower
splits, many emergency fix cycles over ~2 hours). The DB worked fine for the first
~25 beads then started failing on `br update --claim` with the identical
"cursor must be on a leaf to delete" error.

Additional findings:
- `br sync` (JSONL → SQLite reimport) also fails on the corrupted DB with
  "malformed SQLite record blob" — simply deleting the DB isn't enough if
  the JSONL was flushed from a corrupted state
- The JSONL itself is valid JSON (all 111 lines parse correctly) but `br sync`
  chokes during SQLite import, suggesting the issue is in br's import logic
  when handling certain record combinations
- **Workaround that worked:** restore JSONL from git (`git checkout <commit> -- .beads/issues.jsonl`)
  to a version before the corruption was flushed, then `br sync` succeeds
- The JSONL from the same commit (7123a2f) that was on disk at corruption time
  happened to also work — the corruption may be non-deterministic or triggered
  by specific DB state rather than specific JSONL content

This is now the **third** occurrence across two build runs. The pattern is
consistent: works fine for 15-25 beads, then write operations fail. This
strongly suggests accumulated B-tree damage from many rapid write cycles
rather than a one-time corruption event.

## Status

Not yet reported upstream to beads_rust. Three instances of DB corruption
observed (BUG-001, BUG-002, and the third occurrence above). All show the
same failure pattern. Current mitigation: restore JSONL from git and rebuild.
