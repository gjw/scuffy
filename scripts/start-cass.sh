#!/usr/bin/env bash
#
# Start the CASS memory MCP server for Scuffy.
#
# Prerequisites:
#   - cm (brew install cass_memory_system or build from source)
#
# The server runs at http://127.0.0.1:8766
# Tools: cm_context, cm_feedback, cm_outcome, memory_search, memory_reflect
#

set -euo pipefail

PORT="${CASS_PORT:-8766}"
HOST="${CASS_HOST:-127.0.0.1}"

echo "Starting CASS memory server..."
echo "  MCP endpoint: http://${HOST}:${PORT}/mcp"
echo ""

exec cm serve --host "$HOST" --port "$PORT"
