#!/usr/bin/env bash
# Summoner — bead-driven spawn loop for headless Scuffy.
#
# Usage: ./scripts/summoner.sh [workspace-dir]
#
# Spawns Scuffy in headless mode repeatedly. Each session picks up the next
# ready bead, works it, and exits. Exit codes control the loop:
#   0 — finishBead succeeded, loop to next bead
#   1 — escalate called, log and continue (don't block)
#   2+ — unexpected error, log and continue
#
# Brake: touch <workspace>/.pause to stop spawning. Remove to resume.
#
# Environment:
#   AGENT_MAIL_URL   — Agent mail MCP endpoint (default: http://127.0.0.1:8765/mcp)
#   SUMMONER_PAUSE_ON_ESCALATE=1 — pause for Enter on escalation (default: continue)
#   SCUFFY_MCP_SERVERS — MCP server config JSON (passed through to Scuffy)

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIL_URL="${AGENT_MAIL_URL:-http://127.0.0.1:8765/mcp}"
PROJECT_KEY="$(cd "$SCUFFY_ROOT" && pwd)"
PAUSE_ON_ESCALATE="${SUMMONER_PAUSE_ON_ESCALATE:-0}"
MAX_CONSECUTIVE_ESCALATIONS=3
escalation_count=0

# Check agent mail inbox for human overseer messages.
# Only pauses on real messages. Silently ignores errors and empty inboxes.
check_inbox() {
  # Don't even try if mail server isn't reachable
  curl -sS --max-time 2 "$MAIL_URL" >/dev/null 2>&1 || return 0

  local response
  response=$(curl -sS --max-time 5 -X POST "$MAIL_URL" \
    -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"fetch_inbox\",\"arguments\":{\"project_key\":\"$PROJECT_KEY\",\"agent_name\":\"GreenCastle\"}}}" \
    2>/dev/null) || return 0

  # Check for MCP-level errors (tool call failures, not messages)
  local is_error
  is_error=$(echo "$response" | jq -r '.result.isError // false' 2>/dev/null) || return 0
  if [ "$is_error" = "true" ]; then
    return 0
  fi

  # Extract text content from MCP result
  local messages
  messages=$(echo "$response" | jq -r '.result.content[]? | select(.type=="text") | .text' 2>/dev/null) || return 0

  # Skip empty, "no messages", error strings, and null
  if [ -z "$messages" ] || [ "$messages" = "No messages found." ] || [ "$messages" = "null" ]; then
    return 0
  fi
  # Skip if it looks like an error (starts with "Error")
  case "$messages" in Error*) return 0 ;; esac

  echo ""
  echo "=== Human overseer message(s) ==="
  echo "$messages"
  echo "================================="
  echo ""

  # Mark messages as read
  curl -sS --max-time 5 -X POST "$MAIL_URL" \
    -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"mark_message_read\",\"arguments\":{\"project_key\":\"$PROJECT_KEY\",\"agent_name\":\"GreenCastle\"}}}" \
    >/dev/null 2>&1 || true

  read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
}

echo "Summoner started — workspace: $WORKDIR"

while true; do
  # Check for human overseer messages via agent mail
  check_inbox

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
