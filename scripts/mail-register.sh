#!/usr/bin/env bash
#
# Register Scuffy project and agents with mcp_agent_mail.
# Run once after starting the mail server, or after a fresh install.
#
# Usage: ./scripts/mail-register.sh

set -euo pipefail

MAIL_URL="${AGENT_MAIL_URL:-http://127.0.0.1:8765/mcp}"
PROJECT_KEY="/Users/gjw/dev/scuffy"

call_mcp() {
  local id="$1"
  local tool="$2"
  local args="$3"
  local payload
  payload=$(printf '{"jsonrpc":"2.0","id":"%s","method":"tools/call","params":{"name":"%s","arguments":%s}}' "$id" "$tool" "$args")
  curl -sS --max-time 10 -X POST "$MAIL_URL" \
    -H "content-type: application/json" \
    -d "$payload"
  echo ""
}

echo "Registering project..."
call_mcp "1" "ensure_project" "{\"human_key\":\"$PROJECT_KEY\"}"

echo ""
echo "Registering agents..."

for agent in RedTrench BlueTrench GreenTrench SwiftScout BoldTower DarkWarden BrightWarden; do
  echo "  $agent"
  call_mcp "2" "register_agent" "{\"project_key\":\"$PROJECT_KEY\",\"program\":\"scuffy-agent\",\"model\":\"claude-sonnet-4-6\",\"name\":\"$agent\"}"
done

echo ""
echo "Done. Dashboard: http://127.0.0.1:8765/mail"
