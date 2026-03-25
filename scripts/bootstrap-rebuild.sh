#!/usr/bin/env bash
#
# Bootstrap the Ship rebuild workspace.
#
# If no beads exist, runs Scout to create them from BRIEF.md.
# Then starts the summoner loop.
#
# Usage: ./scripts/bootstrap-rebuild.sh [workspace-dir]

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$WORKDIR/BRIEF.md" ]; then
  echo "Error: $WORKDIR/BRIEF.md not found."
  exit 1
fi

if [ ! -f "$SCUFFY_ROOT/dist/index.js" ]; then
  echo "Building Scuffy..."
  npm run build --prefix "$SCUFFY_ROOT"
fi

# The summoner handles everything: if no beads, it spawns Scout first.
exec "$SCUFFY_ROOT/scripts/summoner.sh" "$WORKDIR"
