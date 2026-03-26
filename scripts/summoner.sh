#!/usr/bin/env bash
# Summoner — role-aware spawn loop for headless Scuffy.
#
# Usage: ./scripts/summoner.sh [workspace-dir]
#
# State machine that decides which role to spawn based on bead state:
#   1. Recover stale in_progress beads from crashed sessions
#   2. No beads → Scout (bootstrap)
#   3. Phase closing → Dark Warden → Trench → Light Warden → Trench → Tower (replan)
#   4. Budget exceeded (exit 2) → Tower splits the bead
#   5. Repeated failure (2x) → Tower review. (3x) → halt bead, flag Chair.
#   6. Ready beads exist → Trench
#   7. Nothing to do → Done
#
# Exit codes from Scuffy:
#   0 — finishBead succeeded
#   1 — escalate called (normal escalation)
#   2 — budget exceeded or bead_too_large (triggers Tower bead-splitting)
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
LAST_OUTPUT=""
ATTEMPTS_FILE="$WORKDIR/.summoner-attempts"
LAST_BEAD_ID=""

# ─── Attempt tracking ─────────────────────────────────────────────────────────

get_attempts() {
  local bead_id="$1"
  if [ -f "$ATTEMPTS_FILE" ]; then
    grep "^${bead_id}=" "$ATTEMPTS_FILE" 2>/dev/null | cut -d= -f2 || echo "0"
  else
    echo "0"
  fi
}

increment_attempts() {
  local bead_id="$1"
  local current
  current=$(get_attempts "$bead_id")
  local next=$((current + 1))
  if [ -f "$ATTEMPTS_FILE" ]; then
    # Remove old entry and add new one
    grep -v "^${bead_id}=" "$ATTEMPTS_FILE" > "$ATTEMPTS_FILE.tmp" 2>/dev/null || true
    mv "$ATTEMPTS_FILE.tmp" "$ATTEMPTS_FILE"
  fi
  echo "${bead_id}=${next}" >> "$ATTEMPTS_FILE"
  echo "$next"
}

reset_attempts() {
  local bead_id="$1"
  if [ -f "$ATTEMPTS_FILE" ]; then
    grep -v "^${bead_id}=" "$ATTEMPTS_FILE" > "$ATTEMPTS_FILE.tmp" 2>/dev/null || true
    mv "$ATTEMPTS_FILE.tmp" "$ATTEMPTS_FILE"
  fi
}

# ─── Stale bead recovery ──────────────────────────────────────────────────────

recover_stale_beads() {
  local stale
  stale=$(cd "$WORKDIR" && br list --json --no-auto-flush 2>/dev/null | jq -r '.[] | select(.status == "in_progress") | .id' 2>/dev/null) || return

  for bead_id in $stale; do
    [ -z "$bead_id" ] && continue
    echo "=== Recovering stale bead: $bead_id ==="
    cd "$WORKDIR" && br update "$bead_id" --status=open --no-auto-flush 2>/dev/null || true
  done
}

# ─── Branch management ─────────────────────────────────────────────────────────

# Check out the existing branch for a bead (if it exists) or reset to main.
# 1st attempt on a failed bead: keep the branch (continue partial work)
# 2nd+ attempt: delete the branch and start fresh from main
prepare_branch() {
  local bead_id="$1"
  local attempts
  attempts=$(get_attempts "$bead_id")

  cd "$WORKDIR" || return

  # Find existing branch for this bead
  local branch
  branch=$(git branch --list "task/${bead_id}-*" 2>/dev/null | sed 's/^[* ]*//' | head -1)

  if [ -z "$branch" ]; then
    # No existing branch — make sure we're on main
    git checkout main 2>/dev/null || git checkout -b main 2>/dev/null || true
    return
  fi

  if [ "$attempts" -le 1 ]; then
    # 1st retry: keep the branch, let agent continue partial work
    echo "  Continuing on existing branch: $branch"
    git checkout "$branch" 2>/dev/null || true
  else
    # 2nd+ retry: delete branch, start fresh from main
    echo "  Deleting stale branch $branch, starting fresh"
    git checkout main 2>/dev/null || true
    git branch -D "$branch" 2>/dev/null || true
  fi
}

# ─── Spawning ──────────────────────────────────────────────────────────────────

spawn_role() {
  local role="$1"
  local extra_args="${2:-}"

  echo "=== Spawning Scuffy as $role ==="
  set +e
  if [ -n "$extra_args" ]; then
    LAST_OUTPUT=$(node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR" --role "$role" --instruction "$extra_args" 2>&1)
  else
    LAST_OUTPUT=$(node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR" --role "$role" 2>&1)
  fi
  local exit_code=$?
  set -e
  echo "$LAST_OUTPUT"
  return $exit_code
}

# Extract bead ID from output (BUDGET_EXCEEDED bead=X or bead_claim lines)
extract_bead_id() {
  # Try BUDGET_EXCEEDED format first
  local id
  id=$(echo "$LAST_OUTPUT" | grep -o 'BUDGET_EXCEEDED bead=[^ ]*' | sed 's/BUDGET_EXCEEDED bead=//' | head -1)
  if [ -n "$id" ] && [ "$id" != "unknown" ]; then
    echo "$id"
    return
  fi
  # Fall back to LAST_BEAD_ID set by claim detection
  echo "$LAST_BEAD_ID"
}

# Try to detect which bead was claimed from session output
detect_claimed_bead() {
  LAST_BEAD_ID=$(echo "$LAST_OUTPUT" | grep -o 'Claimed bead [^ :]*' | sed 's/Claimed bead //' | head -1)
}

# ─── Bead query helpers ────────────────────────────────────────────────────────

bead_count() {
  local out
  out=$(cd "$WORKDIR" && br list --json --no-auto-flush 2>/dev/null) || { echo "0"; return; }
  echo "$out" | jq 'length' 2>/dev/null || echo "0"
}

ready_count() {
  local out
  out=$(cd "$WORKDIR" && br ready --json --no-auto-flush 2>/dev/null) || { echo "0"; return; }
  echo "$out" | jq 'length' 2>/dev/null || echo "0"
}

closing_phase() {
  cd "$WORKDIR" || return
  local beads
  beads=$(br list --json --no-auto-flush 2>/dev/null) || return

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

# ─── Phase close sequence ─────────────────────────────────────────────────────

run_phase_close() {
  local phase="$1"
  echo "=== Phase closing: $phase ==="

  spawn_role "warden-dark" "Audit phase $phase. Focus on code completed with label $phase." || true
  drain_warden_beads
  spawn_role "warden-light" "Audit phase $phase. Focus on code completed with label $phase." || true
  drain_warden_beads

  echo "=== Phase $phase closed. Invoking Tower for replan. ==="
  spawn_role "tower" "Phase $phase is complete. Review remaining work, reprioritize, create new beads if needed." || true
}

drain_warden_beads() {
  while true; do
    local warden_ready
    warden_ready=$(cd "$WORKDIR" && br list --json --no-auto-flush 2>/dev/null | jq '[.[] | select(.status != "closed") | select(.labels != null) | select(.labels[] == "warden")] | length' 2>/dev/null || echo "0")
    if [ "$warden_ready" = "0" ] || [ -z "$warden_ready" ]; then
      break
    fi
    echo "=== $warden_ready warden bead(s) to fix ==="
    spawn_role "trench"
    handle_exit $?
  done
}

# ─── Tower interventions ───────────────────────────────────────────────────────

split_bead() {
  local bead_id="$1"
  echo "=== Budget exceeded on $bead_id. Invoking Tower to split. ==="
  cd "$WORKDIR" && br update "$bead_id" --status=open --no-auto-flush 2>/dev/null || true
  spawn_role "tower" "Bead $bead_id exceeded the token budget and could not complete in one session. Read the bead description with br show $bead_id. Examine any partial work on disk. Use the createBead tool to split this bead into 2-3 smaller beads. Then use the closeBead tool to close the original. Call escalate when done." || true
}

tower_review_bead() {
  local bead_id="$1"
  echo "=== Bead $bead_id failed twice. Invoking Tower to review. ==="
  cd "$WORKDIR" && br update "$bead_id" --status=open --no-auto-flush 2>/dev/null || true
  spawn_role "tower" "Bead $bead_id has failed twice. Trench could not complete it. Read the bead description with br show $bead_id and examine the codebase. Is the description wrong? Is it too big? Does it conflict with existing code? Either: (1) use createBead to split it into smaller beads and closeBead to close the original, (2) update the description if it's wrong, or (3) closeBead it if it's no longer needed. Call escalate when done." || true
}

halt_bead() {
  local bead_id="$1"
  echo "=== Bead $bead_id failed 3 times. Halting. ==="
  cd "$WORKDIR" && br update "$bead_id" --labels=blocked --no-auto-flush 2>/dev/null || true
  # TODO: send mail to Chair when agent mail is connected
}

# ─── Exit handling ─────────────────────────────────────────────────────────────

handle_exit() {
  local exit_code=$1
  detect_claimed_bead

  case $exit_code in
    0)
      echo "=== Bead complete. ==="
      if [ -n "$LAST_BEAD_ID" ]; then
        reset_attempts "$LAST_BEAD_ID"
      fi
      ;;
    1)
      echo "=== Scuffy escalated. ==="
      local bead_id
      bead_id=$(extract_bead_id)

      if [ -n "$bead_id" ]; then
        local attempts
        attempts=$(increment_attempts "$bead_id")
        echo "  Bead $bead_id: attempt $attempts"

        if [ "$attempts" -ge 3 ]; then
          halt_bead "$bead_id"
        elif [ "$attempts" -ge 2 ]; then
          tower_review_bead "$bead_id"
        else
          # 1st failure: prepare branch for retry, continue
          prepare_branch "$bead_id"
          sleep 3
        fi
      else
        if [ "$PAUSE_ON_ESCALATE" = "1" ]; then
          read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
        else
          sleep 5
        fi
      fi
      ;;
    2)
      # Budget exceeded or bead_too_large — Tower splits
      local bead_id
      bead_id=$(extract_bead_id)
      if [ -n "$bead_id" ] && [ "$bead_id" != "unknown" ]; then
        local attempts
        attempts=$(increment_attempts "$bead_id")
        if [ "$attempts" -ge 3 ]; then
          halt_bead "$bead_id"
        else
          split_bead "$bead_id"
        fi
      else
        echo "=== Budget exceeded but could not identify bead. ==="
        sleep 5
      fi
      ;;
    *)
      echo "=== Unexpected exit ($exit_code). ==="
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

  # Recover stale in_progress beads from crashed sessions
  recover_stale_beads

  # Decision: what role to spawn?
  TOTAL=$(bead_count)
  READY=$(ready_count)

  # 1. No beads → Scout (escalation is expected — Scout has no bead to finish)
  if [ "$TOTAL" = "0" ]; then
    echo "=== No beads found. Running Scout to bootstrap. ==="
    spawn_role "scout" || true
    echo "=== Scout done. Checking for beads... ==="
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
