#!/usr/bin/env bash
# Summoner — bead-driven spawn loop for headless Scuffy.
#
# Usage: ./scripts/summoner.sh [workspace-dir]
#
# Spawns Scuffy in headless mode repeatedly. Each session picks up the next
# ready bead, works it, and exits. Exit codes control the loop:
#   0 — finishBead succeeded, loop to next bead
#   1 — escalate called, pause for human review
#   2+ — unexpected error, pause for human review
#
# Brake: touch <workspace>/.pause to stop spawning. Remove to resume.

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAX_SLOTS=1  # Hook for future multi-scuffy

echo "Summoner started — workspace: $WORKDIR"

while true; do
  # Brake check
  if [ -f "$WORKDIR/.pause" ]; then
    echo "Paused. Remove $WORKDIR/.pause to resume."
    while [ -f "$WORKDIR/.pause" ]; do sleep 5; done
    echo "Resumed."
  fi

  # Check for ready work
  NEXT=$(cd "$WORKDIR" && br ready --json 2>/dev/null | jq -r '.[0].id // empty')
  if [ -z "$NEXT" ]; then
    echo "No beads ready. Done."
    break
  fi

  echo "=== Spawning Scuffy (next bead: $NEXT) ==="

  # Spawn headless Scuffy
  set +e
  node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR"
  EXIT=$?
  set -e

  # Handle exit code
  case $EXIT in
    0)
      echo "=== Bead complete. Continuing... ==="
      ;;
    1)
      echo "=== Scuffy escalated. Review needed. ==="
      read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
      ;;
    *)
      echo "=== Unexpected exit ($EXIT). Review needed. ==="
      read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
      ;;
  esac
done

echo "Summoner finished."
