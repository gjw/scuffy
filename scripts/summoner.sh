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
MAIL_URL="${AGENT_MAIL_URL:-http://127.0.0.1:8765/mcp}"
PROJECT_KEY="$(cd "$SCUFFY_ROOT" && pwd)"
MAX_SLOTS=1  # Hook for future multi-scuffy

# Check agent mail inbox for human overseer messages.
# If found, display them and pause.
check_inbox() {
  local response
  response=$(curl -sS -X POST "$MAIL_URL" \
    -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"fetch_inbox\",\"arguments\":{\"project_key\":\"$PROJECT_KEY\",\"agent_name\":\"scuffy\",\"unread_only\":true}}}" \
    2>/dev/null) || return 0

  # Extract text content from MCP result
  local messages
  messages=$(echo "$response" | jq -r '.result.content[]? | select(.type=="text") | .text' 2>/dev/null) || return 0

  if [ -n "$messages" ] && [ "$messages" != "No messages found." ] && [ "$messages" != "null" ]; then
    echo ""
    echo "=== Human overseer message(s) ==="
    echo "$messages"
    echo "================================="
    echo ""

    # Mark messages as read
    curl -sS -X POST "$MAIL_URL" \
      -H "content-type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"mark_message_read\",\"arguments\":{\"project_key\":\"$PROJECT_KEY\",\"agent_name\":\"scuffy\"}}}" \
      >/dev/null 2>&1 || true

    read -r -p "Press Enter to continue (or Ctrl+C to stop)... "
  fi
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
