# BUG-001 Investigation Results (2026-03-25)

## Original assumption: SQLite corruption

We assumed the beads SQLite DB was corrupted because `sqlite3` CLI
reported "database disk image is malformed."

## Actual finding: SQLite version mismatch (NOT corruption)

`br` bundles rusqlite which compiles SQLite 3.52.0. The system `sqlite3`
is 3.50.6 (Android SDK) or 3.51.0 (macOS). The DB format written by
3.52.0 has header fields that older versions can't parse:

- `database pages: 1` on a multi-page file (3.52.0 uses a different
  page count convention)
- `cache page size: 4294965296` (valid in 3.52.0, garbage to 3.51.0)

`br` reads its own DB perfectly. `br doctor` reports integrity OK.
`br list`, `br dep add`, `br close` all work correctly.

**The `sqlite3` CLI cannot be used to inspect `br` databases.**

## Dependency cycle detection: NOT false positives

The CYCLE_DETECTED errors during Scout runs are real. Scout sometimes
reverses the argument order for `br dep add` despite documentation.
When it does `br dep add PARENT CHILD` instead of `br dep add CHILD PARENT`,
it creates a backwards dep. The next correct dep in the other direction
then truly creates a cycle, which `br` correctly rejects.

The deps that succeed are valid. The graph has no cycles (`br dep cycles`
confirms). Scout just can't consistently get the argument order right.

## Dashboard showing 0 closed beads: JSONL deduplication bug

The REAL bug: `br sync --flush-only` appends ALL issues to the JSONL,
including stale states. A bead that was closed can have its closed entry
followed by an older open-state entry from a later sync. When `br` loads
the JSONL, it uses the last entry for each ID, which may be the stale
open state.

Example: ship-rebuild-185 has 5 entries in issues.jsonl — 2 closed,
3 open. The last entry is "open", so `br list` shows it as open despite
being closed in the DB.

This is a `br` bug in the JSONL export/import logic. The `--no-auto-flush`
flag mitigates it by reducing the number of exports.

## Action items

- [x] Stop diagnosing "SQLite corruption" — it's a version mismatch
- [x] The `--no-auto-flush` on Scout beadcreation helps but doesn't fix
      the JSONL dedup bug
- [ ] Report JSONL deduplication bug upstream to beads_rust
- [ ] Consider: dashboard should read from `br list` (which reads the
      SQLite DB correctly) rather than parsing JSONL directly
