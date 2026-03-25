#!/usr/bin/env bash
# Summoner — role-aware spawn loop for headless Scuffy.
#
# Usage: ./scripts/summoner.sh [workspace-dir]
#
# State machine that decides which role to spawn based on bead state:
#   1. No beads → Scout (bootstrap)
#   2. Phase closing → Dark Warden → Trench → Light Warden → Trench → Tower (replan)
#   3. Ready beads exist → Trench
#   4. Nothing to do → Done
#
# Brake: touch <workspace>/.pause to stop spawning. Remove to resume.
#
# Environment:
#   SUMMONER_PAUSE_ON_ESCALATE=1 — pause for Enter on escalation (default: continue)
#   SCUFFY_MCP_SERVERS           — MCP server config JSON (passed through to Scuffy)

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAUSE_ON_ESCALATE="${SUMMONER_PAUSE_ON_ESCALATE:-0}"
MAX_CONSECUTIVE_ESCALATIONS=3
escalation_count=0

# Spawn Scuffy with a specific role. Returns the exit code.
spawn_role() {
  local role="$1"
  local extra_args="${2:-}"

  echo "=== Spawning Scuffy as $role ==="
  set +e
  if [ -n "$extra_args" ]; then
    node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR" --role "$role" --instruction "$extra_args"
  else
    node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR" --role "$role"
  fi
  local exit_code=$?
  set -e
  return $exit_code
}

# Count total beads
bead_count() {
  cd "$WORKDIR" && br list --status=open --status=in_progress --status=closed --json --no-auto-flush 2>/dev/null | jq 'length' 2>/dev/null || echo "0"
}

# Count ready beads
ready_count() {
  cd "$WORKDIR" && br ready --json --no-auto-flush 2>/dev/null | jq 'length' 2>/dev/null || echo "0"
}

# Check if a phase is closing (all beads in phase are closed except none open)
# Returns the phase label if closing, empty otherwise.
closing_phase() {
  cd "$WORKDIR" || return
  local beads
  beads=$(br list --status=open --status=in_progress --status=closed --json --no-auto-flush 2>/dev/null) || return

  # Find phases that have ALL beads closed
  # A phase is "closing" when it has beads, all are closed, and hasn't been audited yet
  echo "$beads" | jq -r '
    . as $all |
    [.[] | select(.labels != null and (.labels | type) == "array") | .labels[] | select(startswith("phase:"))] | unique[] as $phase |
    {
      phase: $phase,
      total: [$all[] | select(.labels != null and (.labels | type) == "array") | select(.labels[] == $phase)] | length,
      open: [$all[] | select(.labels != null and (.labels | type) == "array") | select(.labels[] == $phase) | select(.status != "closed")] | length,
      has_warden: [$all[] | select(.labels != null and (.labels | type) == "array") | select((.labels[] == $phase) and (.labels[] == "warden"))] | length
    } | select(.open == 0 and .has_warden == 0) | .phase
  ' 2>/dev/null | head -1
}

# Run the warden → trench → warden → trench → tower sequence for a phase
run_phase_close() {
  local phase="$1"
  echo "=== Phase closing: $phase ==="

  # Dark Warden audit
  spawn_role "warden-dark" "Audit phase $phase. Focus on code completed with label $phase." || true

  # Work any warden-created beads
  drain_warden_beads

  # Light Warden audit
  spawn_role "warden-light" "Audit phase $phase. Focus on code completed with label $phase." || true

  # Work any warden-created beads
  drain_warden_beads

  echo "=== Phase $phase closed. Invoking Tower for replan. ==="

  # Tower replan
  spawn_role "tower" "Phase $phase is complete. Review remaining work, reprioritize, create new beads if needed." || true
}

# Work through all warden-created beads
drain_warden_beads() {
  while true; do
    local warden_ready
    warden_ready=$(cd "$WORKDIR" && br list --json --no-auto-flush 2>/dev/null | jq '[.[] | select(.status != "closed") | select(.labels != null) | select(.labels[] == "warden")] | length' 2>/dev/null || echo "0")
    if [ "$warden_ready" = "0" ] || [ -z "$warden_ready" ]; then
      break
    fi
    echo "=== $warden_ready warden bead(s) to fix ==="
    spawn_role "trench" || handle_exit $?
  done
}

# Handle exit codes from trench spawns
handle_exit() {
  local exit_code=$1
  case $exit_code in
    0)
      echo "=== Bead complete. ==="
      escalation_count=0
      ;;
    1)
      escalation_count=$((escalation_count + 1))
      echo "=== Scuffy escalated ($escalation_count/$MAX_CONSECUTIVE_ESCALATIONS). ==="
      if [ "$PAUSE_ON_ESCALATE" = "1" ]; then
        read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
      elif [ "$escalation_count" -ge "$MAX_CONSECUTIVE_ESCALATIONS" ]; then
        echo "=== $MAX_CONSECUTIVE_ESCALATIONS consecutive escalations. Stopping. ==="
        exit 1
      else
        sleep 5
      fi
      ;;
    *)
      escalation_count=$((escalation_count + 1))
      echo "=== Unexpected exit ($exit_code). ($escalation_count/$MAX_CONSECUTIVE_ESCALATIONS) ==="
      if [ "$escalation_count" -ge "$MAX_CONSECUTIVE_ESCALATIONS" ]; then
        echo "=== $MAX_CONSECUTIVE_ESCALATIONS consecutive failures. Stopping. ==="
        exit 1
      fi
      sleep 5
      ;;
  esac
}

# ─── Main loop ───────────────────────────────────────────────────────────────

echo "Summoner started — workspace: $WORKDIR"
echo ""

while true; do
  # Brake check
  if [ -f "$WORKDIR/.pause" ]; then
    echo "Paused. Remove $WORKDIR/.pause to resume."
    while [ -f "$WORKDIR/.pause" ]; do sleep 5; done
    echo "Resumed."
  fi

  # Decision: what role to spawn?
  TOTAL=$(bead_count)
  READY=$(ready_count)

  # 1. No beads → Scout
  if [ "$TOTAL" = "0" ]; then
    echo "=== No beads found. Running Scout to bootstrap. ==="
    spawn_role "scout" || handle_exit $?
    continue
  fi

  # 2. Phase closing?
  PHASE=$(closing_phase || true)
  if [ -n "$PHASE" ]; then
    run_phase_close "$PHASE"
    continue
  fi

  # 3. Ready beads → Trench
  if [ "$READY" -gt 0 ]; then
    spawn_role "trench"
    handle_exit $?
    continue
  fi

  # 4. Nothing to do
  echo "No beads ready. Done."
  break
done

echo "Summoner finished."
