#!/usr/bin/env bash
#
# Bootstrap the Ship rebuild workspace.
#
# Sets up a fresh workspace (git, beads, BRIEF.md check), builds Scuffy
# if needed, then starts the summoner loop. Scout handles the rest
# (scaffolding, bead planning).
#
# Usage: ./scripts/bootstrap-rebuild.sh [workspace-dir]

set -euo pipefail

WORKDIR="${1:-workspace/ship-rebuild}"
SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight checks ---

if [ ! -f "$WORKDIR/BRIEF.md" ]; then
  echo "Error: $WORKDIR/BRIEF.md not found."
  echo "Create a BRIEF.md describing the project before bootstrapping."
  exit 1
fi

if [ ! -f "$SCUFFY_ROOT/dist/index.js" ]; then
  echo "Building Scuffy..."
  npm run build --prefix "$SCUFFY_ROOT"
fi

# --- Workspace initialization ---

# Git repo (Scout expects this; summoner needs it for branch ops)
if [ ! -d "$WORKDIR/.git" ]; then
  echo "Initializing git repo in $WORKDIR..."
  git -C "$WORKDIR" init
  git -C "$WORKDIR" add BRIEF.md
  git -C "$WORKDIR" commit -m "Initial BRIEF.md"
fi

# Beads database (prevents br from walking up to the project root)
# Always clean-init: remove stale DB/JSONL so bv doesn't see old beads
if [ -d "$WORKDIR/.beads" ]; then
  echo "Cleaning stale beads..."
  rm -f "$WORKDIR/.beads/beads.db" "$WORKDIR/.beads/beads.db-wal" "$WORKDIR/.beads/issues.jsonl"
fi
if [ ! -d "$WORKDIR/.beads" ]; then
  echo "Initializing beads in $WORKDIR..."
  (cd "$WORKDIR" && br init)
fi

# Sessions directory
mkdir -p "$WORKDIR/.scuffy/sessions"

echo "Workspace ready: $WORKDIR"
echo "Starting summoner..."

# --- Launch summoner ---

exec "$SCUFFY_ROOT/scripts/summoner.sh" "$WORKDIR"
