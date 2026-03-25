#!/usr/bin/env bash
#
# Start the live dashboard server.
#
# Usage: ./scripts/dashboard-live.sh [workspace-dir] [--port N]
#
# Dashboard at http://localhost:3001/dashboard (default port)
# Auto-refreshes when sessions complete.

set -euo pipefail

SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec npx tsx "$SCUFFY_ROOT/src/dashboard/server.ts" "$@"
