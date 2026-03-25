#!/usr/bin/env bash
#
# Reset the Ship rebuild workspace to a clean state.
# Keeps BRIEF.md, nukes everything else, re-inits git and beads.
#
# Usage: ./scripts/reset-workspace.sh [workspace-dir]
#
# WARNING: This deletes all code, beads, and git history in the workspace.
# BRIEF.md is preserved.

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"

if [ ! -f "$WORKDIR/BRIEF.md" ]; then
  echo "Error: $WORKDIR/BRIEF.md not found. Is this the right workspace?"
  exit 1
fi

echo "Resetting workspace: $WORKDIR"
echo "This will DELETE everything except BRIEF.md."
read -r -p "Continue? (y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# Save BRIEF.md
cp "$WORKDIR/BRIEF.md" /tmp/ship-BRIEF-backup.md

# Nuke everything
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# Restore BRIEF.md
cp /tmp/ship-BRIEF-backup.md "$WORKDIR/BRIEF.md"

# Create DCG overrides (allow rm -rf in workspace, keep git safety)
cat > "$WORKDIR/.dcg.toml" << 'DCGEOF'
[overrides]
allow = [
    "rm -rf",
    "rm -r ",
]
DCGEOF

# Init git
cd "$WORKDIR"
git init -q
echo "node_modules/" > .gitignore
echo "dist/" >> .gitignore
echo ".scuffy/" >> .gitignore
git add -A
git commit -q -m "Initial workspace: BRIEF.md"

# Init beads
br init 2>/dev/null || true

echo ""
echo "Workspace reset complete."
echo "  BRIEF.md preserved"
echo "  Git initialized (1 commit)"
echo "  Beads initialized (empty)"
echo ""
echo "To start Scuffy:"
echo "  ./scripts/bootstrap-rebuild.sh"
