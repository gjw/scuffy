#!/usr/bin/env bash
# 3scuffy5me.sh — Full workspace setup + summoner launch in one script.
#
# Creates a fresh workspace (or resets an existing one), copies BRIEF-v2.md,
# inits git + beads, builds Scuffy if needed, loads .env, and starts the
# summoner with Judicar enabled.
#
# Usage: ./scripts/3scuffy5me.sh [workspace-dir]

set -euo pipefail

WORKSPACE="${1:-workspace/ship-rebuild}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCUFFY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SCUFFY_ROOT"

BRIEF_SRC="notes/BRIEF-v2.md"

if [ ! -f "$BRIEF_SRC" ]; then
  echo "Error: $BRIEF_SRC not found."
  exit 1
fi

# --- Build Scuffy if needed ---

if [ ! -f "dist/index.js" ]; then
  echo "Building Scuffy..."
  npm run build
fi

# --- Full workspace reset ---

if [ -d "$WORKSPACE/.git" ]; then
  echo "Resetting workspace: $WORKSPACE"

  # Remove all worktrees first (git worktree remove fails if .git is gone)
  if [ -d "$WORKSPACE/.worktrees" ]; then
    for wt in "$WORKSPACE"/.worktrees/*/; do
      [ -d "$wt" ] && git -C "$WORKSPACE" worktree remove --force "$wt" 2>/dev/null || true
    done
    rm -rf "$WORKSPACE/.worktrees"
  fi

  # Nuke everything, start clean
  rm -rf "$WORKSPACE"
fi

mkdir -p "$WORKSPACE"

# Copy brief
cp "$BRIEF_SRC" "$WORKSPACE/BRIEF.md"
echo "Copied $BRIEF_SRC → $WORKSPACE/BRIEF.md"

# Fresh git repo
echo "Initializing git repo..."
git -C "$WORKSPACE" init -q
echo "node_modules/" > "$WORKSPACE/.gitignore"
echo "dist/" >> "$WORKSPACE/.gitignore"
echo ".scuffy/" >> "$WORKSPACE/.gitignore"
git -C "$WORKSPACE" add -A
git -C "$WORKSPACE" commit -q -m "Initial workspace: BRIEF.md"

# Fresh beads
echo "Initializing beads..."
(cd "$WORKSPACE" && br init)

# Sessions directory
mkdir -p "$WORKSPACE/.scuffy/sessions"

# DCG overrides
cat > "$WORKSPACE/.dcg.toml" << 'DCGEOF'
[overrides]
allow = [
    "rm -rf",
    "rm -r ",
]

block = [
    { pattern = "\\bbr\\s+create\\b", reason = "Use the createBead tool instead of br create via bash." },
    { pattern = "\\bbr\\s+dep\\s+add\\b", reason = "Use the createBead tool with dependsOn parameter instead of br dep add." },
]
DCGEOF

# --- Load .env (preserving JSON values with quotes intact) ---

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line%"${line##*[![:space:]]}"}"
    export "$line"
  done < .env
fi

# --- Launch summoner ---

export SCUFFY_PARALLEL_SLOTS="${SCUFFY_PARALLEL_SLOTS:-3}"
export SCUFFY_USE_JUDICAR=1

echo ""
echo "Workspace ready: $WORKSPACE"
echo "  BRIEF.md: v2"
echo "  Parallel slots: $SCUFFY_PARALLEL_SLOTS"
echo "  Judicar: enabled"
echo "Starting summoner..."
echo ""

# Summoner writes its own log file directly (no tee buffering issues).
# Truncate the log so each run starts clean.
: > "$WORKSPACE/summoner.log"
exec npx tsx src/summoner/index.ts "$WORKSPACE" 2>&1
