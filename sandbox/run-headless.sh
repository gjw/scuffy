#!/usr/bin/env bash
#
# Run Scuffy headless mode inside a macOS sandbox.
#
# Usage:
#   ./sandbox/run-headless.sh /path/to/workspace [--instruction "..."]
#
# The workspace directory is the ONLY place Scuffy can write.
# The Scuffy source repo, FleetGraph reference, and system paths are read-only.
#
# Prerequisites:
#   - macOS (sandbox-exec is a macOS built-in)
#   - npm run build (dist/ must exist)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="$SCRIPT_DIR/scuffy-headless.sb"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <workspace-dir> [--instruction \"...\"]"
  echo ""
  echo "  workspace-dir   Directory where the agent can write (e.g., workspace/ship-rebuild)"
  echo "  --instruction   Optional instruction string for headless mode"
  exit 1
fi

WORKSPACE="$(cd "$1" 2>/dev/null && pwd || mkdir -p "$1" && cd "$1" && pwd)"
shift

if [ ! -f "$REPO_ROOT/dist/index.js" ]; then
  echo "Error: dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

echo "Scuffy headless (sandboxed)"
echo "  Workspace: $WORKSPACE"
echo "  Profile:   $PROFILE"
echo ""

# sandbox-exec -D sets parameters accessible via (param "KEY") in the profile
exec sandbox-exec -f "$PROFILE" -D "SCUFFY_WORKSPACE=$WORKSPACE" \
  node "$REPO_ROOT/dist/index.js" --headless --workdir "$WORKSPACE" "$@"
