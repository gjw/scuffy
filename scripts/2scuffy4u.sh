#!/usr/bin/env bash
# 2scuffy4u.sh — Launch the Summoner with 2 parallel slots, logging to summoner.log
#
# Ensures the correct OpenAI (Gauntlet) key is used and pipes output
# to both stdout and the workspace log file.
#
# Usage: ./scripts/2scuffy4u.sh [workspace-dir]

set -euo pipefail

WORKSPACE="${1:-workspace/ship-rebuild}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCUFFY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SCUFFY_ROOT"

# Read .env line-by-line to preserve JSON values with quotes intact.
# Plain `source` strips quotes, mangling SCUFFY_MCP_SERVERS.
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    # Trim trailing whitespace
    line="${line%"${line##*[![:space:]]}"}"
    export "$line"
  done < .env
fi

export SCUFFY_PARALLEL_SLOTS="${SCUFFY_PARALLEL_SLOTS:-3}"
export SCUFFY_USE_JUDICAR=1

exec npx tsx src/summoner/index.ts "$WORKSPACE" 2>&1 | tee "$WORKSPACE/summoner.log"
