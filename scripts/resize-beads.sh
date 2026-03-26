#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build

# Get the first 10 open beads
BEADS=$(cd workspace/ship-rebuild && br list --json --no-auto-flush 2>/dev/null | jq -r '[.[] | select(.status == "open")] | .[0:10] | .[] | "\(.id): \(.title)"' 2>/dev/null)

if [ -z "$BEADS" ]; then
  echo "No open beads to resize."
  exit 0
fi

echo "Resizing these beads:"
echo "$BEADS"
echo "---"

INSTRUCTION="DO NOT call claimBead. Direct assignment from Chair.

Review these 10 beads and split any that are too large for one session (more than one focused deliverable). Target: each bead completable in under 25 tool calls — that means ONE new file, OR ONE set of edits to an existing file, OR ONE test file. NOT multiple.

For each bead that needs splitting: use createBead to make 2-3 smaller replacement beads, then closeBead to close the original.

For beads that are already small enough: leave them alone.

Here are the beads to review:

$BEADS

Use br show <id> --json to read each bead's description before deciding whether to split. Call escalate when done."

node dist/index.js --headless --workdir workspace/ship-rebuild --role trench --instruction "$INSTRUCTION"
