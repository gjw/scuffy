#!/usr/bin/env bash
#
# Generate and open the factory dashboard.
#
# Usage: ./scripts/dashboard.sh [workspace-dir]
#

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec npx tsx "$SCUFFY_ROOT/src/dashboard/cli.ts" "$WORKDIR"
