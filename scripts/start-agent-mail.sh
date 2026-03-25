#!/usr/bin/env bash
#
# Start the mcp_agent_mail server for Scuffy agent coordination.
#
# Prerequisites:
#   - uv (https://docs.astral.sh/uv/)
#
# The server runs at http://127.0.0.1:8765
# Web dashboard: http://127.0.0.1:8765/mail
# MCP endpoint:  http://127.0.0.1:8765/mcp (Streamable HTTP)
#
# Storage defaults to ~/.mcp_agent_mail_git_mailbox_repo
# Override with STORAGE_ROOT env var.
#

set -euo pipefail

PORT="${AGENT_MAIL_PORT:-8765}"
HOST="${AGENT_MAIL_HOST:-127.0.0.1}"

echo "Starting mcp_agent_mail server..."
echo "  MCP endpoint: http://${HOST}:${PORT}/mcp"
echo "  Web dashboard: http://${HOST}:${PORT}/mail"
echo ""

exec uvx --python 3.12 --from mcp_agent_mail \
  python -m mcp_agent_mail.http --host "$HOST" --port "$PORT"
