#!/usr/bin/env bash
#
# Bootstrap the Ship rebuild workspace.
#
# 1. Runs Scuffy once in headless mode with a bootstrap instruction
#    that reads BRIEF.md and creates beads using `br create`.
# 2. Then starts the summoner loop to work through them.
#
# Prerequisites:
#   - npm run build (dist/ must exist)
#   - Workspace must have BRIEF.md and initialized git + beads
#     (run reset-workspace.sh first if starting fresh)
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

# Check if beads already exist
BEAD_COUNT=$(cd "$WORKDIR" && br list --json 2>/dev/null | jq 'length' 2>/dev/null || echo "0")
if [ "$BEAD_COUNT" -gt 0 ]; then
  echo "Workspace already has $BEAD_COUNT beads. Skipping bootstrap, starting summoner."
  exec "$SCUFFY_ROOT/scripts/summoner.sh" "$WORKDIR"
fi

echo "=== Bootstrap phase: creating beads from BRIEF.md ==="

BOOTSTRAP_INSTRUCTION='Read BRIEF.md carefully. You are building the Ship app from scratch in this workspace.

Your job in this session is ONLY to plan and create beads. Do not write any code.

1. Read BRIEF.md to understand what needs to be built.
2. Break the work into 15-25 sequential beads using `br create` via the bash tool.
   Each bead should be a focused task (schema, API endpoint, frontend component, etc.).
   Use priorities: P0 for foundation/scaffold, P1 for core APIs, P2 for frontend/secondary, P3 for polish/tests.
   Add dependencies with `br dep add <bead> <depends-on>` so work is ordered correctly.
3. After creating all beads, run `br ready` to verify the first bead is actionable.
4. Call escalate with reason "blocked" and message "Bootstrap complete: beads created. Ready for summoner."

Do NOT call finishBead — there is no bead to finish. Call escalate when done planning.'

node "$SCUFFY_ROOT/dist/index.js" --headless --workdir "$WORKDIR" \
  --instruction "$BOOTSTRAP_INSTRUCTION"

echo ""
echo "=== Bootstrap complete. Starting summoner. ==="
echo ""

exec "$SCUFFY_ROOT/scripts/summoner.sh" "$WORKDIR"
