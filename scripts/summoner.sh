#!/usr/bin/env bash
#
# Summoner — TypeScript rewrite. This script is just a launcher.
#
# Usage: ./scripts/summoner.sh [workspace-dir]

set -euo pipefail

SCUFFY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec npx tsx "$SCUFFY_ROOT/src/summoner/index.ts" "$@"
