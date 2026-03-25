#!/usr/bin/env bash
# Summoner — bead-driven spawn loop for headless Scuffy.
#
# Usage: ./scripts/summoner.sh [workspace-dir]
#
# Spawns Scuffy in headless mode repeatedly. Each session picks up the next
# ready bead, works it, and exits. Exit codes control the loop:
#   0 — finishBead succeeded, loop to next bead
#   1 — escalate called, log and continue
#   2+ — unexpected error, log and continue
#
# Stops after MAX_CONSECUTIVE_ESCALATIONS failures in a row (default 3).
# Brake: touch <workspace>/.pause to stop spawning. Remove to resume.
#
# Environment:
#   SUMMONER_PAUSE_ON_ESCALATE=1 — pause for Enter on escalation (default: continue)
#   SCUFFY_MCP_SERVERS — MCP server config JSON (passed through to Scuffy)

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAUSE_ON_ESCALATE="${SUMMONER_PAUSE_ON_ESCALATE:-0}"
MAX_CONSECUTIVE_ESCALATIONS=3
escalation_count=0

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
      escalation_count=0
      ;;
    1)
      escalation_count=$((escalation_count + 1))
      echo "=== Scuffy escalated ($escalation_count/$MAX_CONSECUTIVE_ESCALATIONS). ==="
      if [ "$PAUSE_ON_ESCALATE" = "1" ]; then
        read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
      elif [ "$escalation_count" -ge "$MAX_CONSECUTIVE_ESCALATIONS" ]; then
        echo "=== $MAX_CONSECUTIVE_ESCALATIONS consecutive escalations. Stopping. ==="
        break
      else
        echo "Continuing in 5s..."
        sleep 5
      fi
      ;;
    *)
      escalation_count=$((escalation_count + 1))
      echo "=== Unexpected exit ($EXIT). ($escalation_count/$MAX_CONSECUTIVE_ESCALATIONS) ==="
      if [ "$escalation_count" -ge "$MAX_CONSECUTIVE_ESCALATIONS" ]; then
        echo "=== $MAX_CONSECUTIVE_ESCALATIONS consecutive failures. Stopping. ==="
        break
      fi
      sleep 5
      ;;
  esac
done

echo "Summoner finished."
