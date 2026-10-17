#!/bin/sh
# Creates one git worktree per build brief next to the repo, copies .env, installs deps.
# Usage: sh scripts/make-worktrees.sh   (run from the repo root)
set -e
ROOT=$(pwd)
WT="$ROOT/../hive-wt"
mkdir -p "$WT"
for b in 01-core-state 02-coordination 03-api-server 04-runner-culprit 05-agent-loop 06-web-ui 07-demo-app-bench; do
  dir="$WT/$b"
  if [ ! -d "$dir" ]; then
    if git show-ref --verify --quiet "refs/heads/build/$b"; then
      git worktree add -q "$dir" "build/$b"
    else
      git worktree add -q "$dir" -b "build/$b"
    fi
  fi
  cp "$ROOT/.env" "$dir/.env"
  chmod 600 "$dir/.env"
  if (cd "$dir" && npm ci --no-audit --no-fund >/dev/null 2>&1); then echo "ready: $dir"; else echo "npm ci FAILED: $dir"; fi
done
